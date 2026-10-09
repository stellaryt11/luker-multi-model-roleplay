// SPDX-License-Identifier: MIT
/**
 * 四层流水线：场景 → 人物 → 整合 → 渲染。
 *
 * 关键设计决策（已与需求方确认）：
 *  1. 强度路由**按回合**而非按段落。一条消息内换模型会造成一条消息内两种
 *     笔触，这是用户最能察觉的破绽。本回合的最高强度决定整条用哪个渲染器。
 *  2. 只有渲染层流式输出。前三层是准备阶段，用进度占位维持体感。
 *  3. 场景层不看角色卡 —— 既省 token，也避免它被角色情绪带跑。
 *  4. 渲染层是唯一的正文作者，前三层永不输出露骨正文：网关对前三层的
 *     静默阉割不会污染叙事，审查暴露面被隔离在最后一层。
 */

import {
    appendReasoning,
    clampText,
    collectRecentTranscript,
    extractJson,
    getLastUserMessage,
    getStyleAnchor,
    logDebug,
    logWarn,
    looksDegenerate,
    pipeStreamIntoHandle,
} from './utils.js';

import {
    ACTOR_SCHEMA,
    ACTOR_SYSTEM,
    ACTOR_TASK,
    MERGE_SCHEMA,
    MERGE_SYSTEM,
    MERGE_TASK,
    RENDER_RETRY_NOTE,
    RENDER_SYSTEM_HEAVY,
    RENDER_SYSTEM_LIGHT,
    RENDER_TASK,
    SCENE_SCHEMA,
    SCENE_SYSTEM,
    SCENE_TASK,
    fillTemplate,
    renderActorCard,
    renderRenderPlan,
    renderSceneCard,
    wrapJsonSchema,
} from './prompts.js';

import { resolvePrepPresetName } from './pure-preset.js';
import { buildInjectionArgs } from './custom-api.js';

const REASONING_CAP = 2000;

/**
 * 跑一整轮四层流水线，把结果灌进 handle。
 *
 * @param {object} params
 * @param {object} params.ctx Luker context
 * @param {object} params.eventData GENERATE_TAKEOVER_DISPATCH 的事件载荷
 * @param {object} params.handle createMessageEditorHandle 返回的句柄
 * @param {object} params.settings 插件设置
 * @returns {Promise<{intensity:number, renderProfile:string, timings:object}>}
 */
export async function runPipeline({ ctx, eventData, handle, settings }) {
    const generationType = eventData.type;
    const base = generationType === 'continue' ? (handle.getText() || '') : '';
    const timings = {};
    const showProgress = settings.showProgress !== false;

    // ── 上下文收集 ───────────────────────────────────────────────────────
    const recentChat = collectRecentTranscript(ctx, Number(settings.recentMessageCount) || 12);
    const lastUser = getLastUserMessage(ctx);
    const styleAnchor = settings.styleAnchorEnabled
        ? getStyleAnchor(ctx, generationType, Number(settings.styleAnchorChars) || 600)
        : '';

    logDebug('上下文', { generationType, recentChatLength: recentChat.length, styleAnchorLength: styleAnchor.length });

    const setProgress = (text) => {
        if (!showProgress) return;
        try {
            handle.setText(base + text);
        } catch (err) {
            logDebug('进度占位写入失败', err);
        }
    };

    // ── ① 场景层：世界的事实 ─────────────────────────────────────────────
    setProgress('*正在构建场景事实…*');
    const sceneStart = now();
    const sceneResult = await callLayer(ctx, {
        settings,
        abortSignal: eventData.abortSignal,
        timeoutMs: settings.requestTimeoutMs,
        apiPresetName: settings.sceneApiProfile,
        llmPresetName: resolvePrepPresetName(settings, settings.scenePreset),
        systemPrompt: settings.sceneSystemOverride || SCENE_SYSTEM,
        taskTemplate: SCENE_TASK,
        values: { recent_chat: recentChat, last_user: lastUser },
        jsonSchema: wrapJsonSchema('scene_fact_card', SCENE_SCHEMA),
        includeCharacterCard: false,
        worldInfoSource: 'chat',
        label: '场景层',
    });
    timings.scene = now() - sceneStart;

    const sceneCard = extractJson(sceneResult.assistantText);
    if (!sceneCard) {
        logWarn('场景层未返回可解析 JSON，使用降级文本传递');
    }
    const sceneText = sceneCard ? renderSceneCard(sceneCard) : clampText(sceneResult.assistantText, 1500);

    // ── ② 人物层：角色的意志 ─────────────────────────────────────────────
    setProgress('*正在裁决角色反应…*');
    const actorStart = now();
    const actorResult = await callLayer(ctx, {
        settings,
        abortSignal: eventData.abortSignal,
        timeoutMs: settings.requestTimeoutMs,
        apiPresetName: settings.actorApiProfile,
        llmPresetName: resolvePrepPresetName(settings, settings.actorPreset),
        systemPrompt: settings.actorSystemOverride || ACTOR_SYSTEM,
        taskTemplate: ACTOR_TASK,
        values: { scene_card: sceneText, recent_chat: recentChat, last_user: lastUser },
        jsonSchema: wrapJsonSchema('character_will', ACTOR_SCHEMA),
        includeCharacterCard: true,
        worldInfoSource: 'chat',
        label: '人物层',
    });
    timings.actor = now() - actorStart;

    const actorCard = extractJson(actorResult.assistantText);
    if (!actorCard) {
        logWarn('人物层未返回可解析 JSON，使用降级文本传递');
    }
    const actorText = actorCard ? renderActorCard(actorCard) : clampText(actorResult.assistantText, 1500);

    // 强度判定权属于人物层（它持有角色意志）。缺值时保守取 0。
    const rawIntensity = Number(actorCard?.nsfw_intensity ?? 0);
    const actorIntensity = Number.isFinite(rawIntensity) ? Math.min(3, Math.max(0, Math.round(rawIntensity))) : 0;

    // ── ③ 整合层：文本的形态 ─────────────────────────────────────────────
    setProgress('*正在整合渲染指令…*');
    const mergeStart = now();
    const mergeResult = await callLayer(ctx, {
        settings,
        abortSignal: eventData.abortSignal,
        timeoutMs: settings.requestTimeoutMs,
        apiPresetName: settings.mergeApiProfile,
        llmPresetName: resolvePrepPresetName(settings, settings.mergePreset),
        systemPrompt: settings.mergeSystemOverride || MERGE_SYSTEM,
        taskTemplate: MERGE_TASK,
        values: {
            scene_card: sceneText,
            actor_card: actorText,
            recent_chat: recentChat,
            last_user: lastUser,
            style_anchor: styleAnchor || '（本次没有可用的上文，正常开篇）',
        },
        jsonSchema: wrapJsonSchema('render_plan', MERGE_SCHEMA),
        includeCharacterCard: false,
        worldInfoSource: 'none',
        label: '整合层',
    });
    timings.merge = now() - mergeStart;

    const renderPlan = extractJson(mergeResult.assistantText);
    // 整合层只允许沿用或下调强度，绝不上调。
    const planIntensityRaw = Number(renderPlan?.nsfw_intensity ?? actorIntensity);
    const planIntensity = Number.isFinite(planIntensityRaw)
        ? Math.min(actorIntensity, Math.max(0, Math.round(planIntensityRaw)))
        : actorIntensity;

    const planText = renderPlan
        ? renderRenderPlan({ ...renderPlan, nsfw_intensity: planIntensity })
        : clampText(mergeResult.assistantText, 2000);

    // ── 强度路由（按回合）────────────────────────────────────────────────
    const threshold = Number(settings.nsfwThreshold) || 2;
    const wantsHeavy = planIntensity >= threshold;
    let route = resolveRenderRoute(settings, wantsHeavy);
    if (!route) {
        // heavy 未配置且不允许回退 —— 退到当前聊天配置，至少不空转
        logWarn('高强度渲染器未配置且未允许回退，使用当前聊天 API 配置');
        route = { profile: '', preset: '', tier: 'fallback' };
    }

    logDebug('强度路由', { planIntensity, threshold, tier: route.tier });

    // ── ④ 渲染层：唯一的正文作者 ─────────────────────────────────────────
    setProgress(`*正在执笔（强度 ${planIntensity}）…*`);

    const renderValues = {
        render_plan: planText,
        character_card: '', // 由 includeCharacterCard 注入，模板中留空占位
        style_anchor: styleAnchor || '（本次没有可用的上文，正常开篇）',
        last_user: lastUser,
    };
    const renderSystem = route.tier === 'heavy'
        ? (settings.renderHeavySystemOverride || RENDER_SYSTEM_HEAVY)
        : (settings.renderLightSystemOverride || RENDER_SYSTEM_LIGHT);

    const renderStart = now();
    let finalText = await renderOnce({
        ctx,
        handle,
        base,
        eventData,
        settings,
        route,
        systemPrompt: renderSystem,
        values: renderValues,
        label: '渲染层',
    });
    timings.render = now() - renderStart;

    // ── 异常检测：网关静默阉割是看不见的失败，必须检测 ──────────────────
    let degeneracy = looksDegenerate(finalText.slice(base.length), planIntensity);
    if (degeneracy && settings.retryOnDegenerate) {
        logWarn(`渲染结果疑似无效（${degeneracy}），重试一次`);
        timings.renderRetry = 0;
        const retryStart = now();
        finalText = await renderOnce({
            ctx,
            handle,
            base,
            eventData,
            settings,
            route,
            systemPrompt: renderSystem,
            values: renderValues,
            label: '渲染层(重试)',
            retryReason: degeneracy,
        });
        timings.renderRetry = now() - retryStart;
        degeneracy = looksDegenerate(finalText.slice(base.length), planIntensity);
        if (degeneracy) {
            logWarn(`重试后仍疑似无效（${degeneracy}），照常提交但请检查上游预设`);
        }
    }

    return { intensity: planIntensity, renderTier: route.tier, timings, degeneracy };
}

/**
 * 解析渲染路由。
 * @returns {{profile:string, preset:string, tier:'light'|'heavy'|'fallback'}|null}
 */
function resolveRenderRoute(settings, wantsHeavy) {
    const heavyProfile = String(settings.renderHeavyApiProfile ?? '').trim();
    const lightProfile = String(settings.renderLightApiProfile ?? '').trim();

    if (wantsHeavy) {
        if (heavyProfile) {
            return { profile: heavyProfile, preset: settings.renderHeavyPreset ?? '', tier: 'heavy' };
        }
        if (settings.heavyFallbackToLight) {
            return {
                profile: lightProfile,
                preset: settings.renderLightPreset ?? '',
                tier: 'light',
            };
        }
        return null;
    }

    return { profile: lightProfile, preset: settings.renderLightPreset ?? '', tier: 'light' };
}

/** 一次渲染调用（流式优先，不可用时降级整段提交）。 */
async function renderOnce({
    ctx,
    handle,
    base,
    eventData,
    settings,
    route,
    systemPrompt,
    values,
    label,
    retryReason = '',
}) {
    let taskContent = fillTemplate(RENDER_TASK, values);
    if (retryReason) {
        taskContent += fillTemplate(RENDER_RETRY_NOTE, { reason: retryReason });
    }

    const taskMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: taskContent },
    ];

    const common = {
        taskMessages,
        apiPresetName: route.profile,
        llmPresetName: route.preset,
        includeCharacterCard: true,
        worldInfoSource: 'none',
        abortSignal: eventData.abortSignal,
    };

    // 流式：边生成边渲染，这是用户唯一能感受到"正在打字"的一层。
    if (typeof ctx.generateTaskStream === 'function') {
        try {
            const injected = buildInjectionArgs(ctx, settings, route.profile);
            const { stream } = ctx.generateTaskStream(common, injected);
            return await pipeStreamIntoHandle(handle, stream, { base });
        } catch (err) {
            if (isAbort(err, eventData.abortSignal)) throw err;
            logWarn(`${label} 流式失败，降级为整段提交`, err);
        }
    }

    const result = await callLayer(ctx, {
        ...common,
        settings,
        systemPrompt,
        taskTemplate: taskContent,
        values: {},
        prebuiltUserContent: taskContent,
        rawTemplate: true,
        label,
    });

    const text = base + String(result.assistantText ?? '');
    handle.setText(text);
    if (result.reasoning) {
        appendReasoning(handle, String(result.reasoning).slice(0, REASONING_CAP));
    }
    return text;
}

/**
 * 调用一层，返回归一化结果。
 * 支持两种模式：模板 + 变量（前三层），或直接给定 user 内容（渲染层降级路径）。
 */
async function callLayer(ctx, params) {
    const {
        abortSignal,
        timeoutMs,
        apiPresetName,
        llmPresetName,
        systemPrompt,
        taskTemplate,
        values,
        jsonSchema,
        includeCharacterCard,
        worldInfoSource,
        label,
        prebuiltUserContent,
        rawTemplate,
        settings,
    } = params;

    const userContent = rawTemplate ? taskTemplate : fillTemplate(taskTemplate, values);

    const request = {
        taskMessages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
        apiPresetName: apiPresetName || '',
        llmPresetName: llmPresetName || '',
        includeCharacterCard: Boolean(includeCharacterCard),
        worldInfoSource: worldInfoSource || 'none',
        abortSignal,
    };
    if (jsonSchema) {
        request.jsonSchema = jsonSchema;
    }

    const { signal, cleanup } = withTimeout(abortSignal, Number(timeoutMs) || 0);
    request.abortSignal = signal;

    try {
        // 只有引用自定义连接时才注入 resolver；走 Connection Profile 的调用
        // 保持与之前完全一致，不依赖任何半私有接口。
        const injected = buildInjectionArgs(ctx, settings, apiPresetName);

        try {
            const result = await ctx.generateTask(request, injected);
            logDebug(`${label} 完成`, {
                textLength: String(result?.assistantText ?? '').length,
                usage: result?.usage ?? null,
            });
            return result ?? { assistantText: '' };
        } catch (err) {
            if (isAbort(err, abortSignal)) throw err;

            // 不少自建端点 / 中转不支持 response_format.json_schema。
            // 没必要因此整轮失败 —— 前三层的 taskMessages 里本来就写了
            // "严格返回 JSON"，去掉 schema 重试一次通常仍能得到合法 JSON。
            if (!request.jsonSchema || !looksLikeSchemaUnsupported(err)) {
                throw err;
            }

            logWarn(`${label} 的端点不支持 jsonSchema，去掉结构约束重试一次`);
            const fallbackRequest = { ...request };
            delete fallbackRequest.jsonSchema;

            const result = await ctx.generateTask(fallbackRequest, injected);
            logDebug(`${label} 完成（已降级，无结构约束）`, {
                textLength: String(result?.assistantText ?? '').length,
            });
            return result ?? { assistantText: '' };
        }
    } finally {
        cleanup();
    }
}

/** 把用户 abort 信号与超时合成一个信号。 */
function withTimeout(abortSignal, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === 'undefined') {
        return { signal: abortSignal ?? undefined, cleanup: () => {} };
    }

    // 优先用原生的组合 API（Chromium 系都支持）
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
        try {
            return { signal: AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)].filter(Boolean)), cleanup: () => {} };
        } catch {
            /* 落到手动实现 */
        }
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(abortSignal?.reason);
    if (abortSignal) {
        if (abortSignal.aborted) controller.abort(abortSignal.reason);
        else abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timer);
            if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        },
    };
}

/** 判断错误是否为「用户主动取消」。 */
export function isAbort(err, abortSignal) {
    if (abortSignal?.aborted) return true;
    const name = String(err?.name ?? '');
    return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * 判断错误是否指向「端点不支持结构化输出」。
 *
 * 上游的报错措辞各式各样，这里只认与 schema / response_format 直接相关的
 * 关键词，避免把普通的限流、鉴权失败误判成可降级错误而白白重试。
 */
export function looksLikeSchemaUnsupported(err) {
    const text = [err?.message, err?.cause?.message, err?.details]
        .map((value) => String(value ?? ''))
        .join(' ');

    if (/rate.?limit|429|unauthor|401|forbidden|403/i.test(text)) {
        return false;
    }
    return /json_schema|json schema|response_format|structured output/i.test(text);
}

function now() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}
