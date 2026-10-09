// SPDX-License-Identifier: MIT
/**
 * 基础工具层：能力检测、日志、上下文收集、坐标无关的小助手。
 *
 * 设计约束：
 *  - 不 import 任何 Luker 核心模块（避免与 AGPL 代码产生链接），
 *    全部通过全局 `Luker.getContext()` 访问。
 *  - 不 import 编排器的 editor-ops.js（那是 AGPL 代码，会污染本仓库）。
 *    本插件需要的编辑原语只有几个，见下方 self-contained 实现。
 */

export const MODULE_NAME = 'multi-model-roleplay';

/**
 * 插件根目录 URL（结尾带 /），用于加载插件根目录下的资源。
 *
 * 注意：本文件位于 `<plugin>/src/`，所以必须从模块 URL **上跳一级**，
 * 否则拼出来的路径会多出一层 `src/`，导致 settings.html 404。
 * 这个坑踩过一次，下面有回归测试兜底。
 */
export const PLUGIN_ROOT_URL = new URL('..', import.meta.url).href;

let debugEnabled = false;

export function setDebugEnabled(value) {
    debugEnabled = Boolean(value);
}

export function logDebug(...args) {
    if (debugEnabled) {
        console.debug(`[${MODULE_NAME}]`, ...args);
    }
}

export function logWarn(...args) {
    console.warn(`[${MODULE_NAME}]`, ...args);
}

export function logError(...args) {
    console.error(`[${MODULE_NAME}]`, ...args);
}

// ---------------------------------------------------------------------------
// 能力检测
// ---------------------------------------------------------------------------

/**
 * 取得 Luker context。若运行在纯 SillyTavern 上则返回 null。
 * 这是本插件唯一的运行环境依赖 —— 全部功能都建立在 Luker 独有 API 上。
 */
export function getLukerContext() {
    try {
        const root = globalThis.Luker ?? globalThis.SillyTavern ?? globalThis.st;
        if (!root || typeof root.getContext !== 'function') {
            return null;
        }
        return root.getContext() ?? null;
    } catch (err) {
        logWarn('读取 context 失败', err);
        return null;
    }
}

/**
 * 探测消息接管能力。
 *
 * 消息接管（GENERATE_TAKEOVER_DISPATCH + createMessageEditorHandle）是
 * Luker 独有机制，SillyTavern 并不提供。检测失败时插件必须安全禁用，
 * 而不是抛错 —— 有人把它装到 ST 上时不应该损坏对方的环境。
 */
export function probeCapabilities() {
    const ctx = getLukerContext();
    const missing = [];

    if (!ctx) {
        return { ok: false, ctx: null, missing: ['Luker context'] };
    }
    if (typeof ctx.createMessageEditorHandle !== 'function') {
        missing.push('createMessageEditorHandle');
    }
    if (!ctx.eventTypes?.GENERATE_TAKEOVER_DISPATCH) {
        missing.push('GENERATE_TAKEOVER_DISPATCH');
    }
    if (typeof ctx.generateTask !== 'function') {
        missing.push('generateTask');
    }
    if (typeof ctx.generateTaskStream !== 'function') {
        // 降级可用：没有流式就整段提交，不算致命。
        logDebug('generateTaskStream 不可用，将降级为非流式提交');
    }

    return { ok: missing.length === 0, ctx, missing };
}

// ---------------------------------------------------------------------------
// 上下文收集
// ---------------------------------------------------------------------------

/**
 * 把最近 N 条可见消息拼成转录文本。
 *
 * @param {object} ctx Luker context
 * @param {number} limit 最多取多少条
 * @returns {string}
 */
export function collectRecentTranscript(ctx, limit) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const picked = [];

    for (let i = chat.length - 1; i >= 0 && picked.length < limit; i -= 1) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        const text = String(message.mes ?? '').trim();
        if (!text) continue;
        const speaker = message.is_user ? (ctx.name1 || 'User') : (message.name || ctx.name2 || 'Character');
        picked.unshift(`${speaker}: ${text}`);
    }

    return picked.join('\n\n');
}

/** 最后一条用户消息的正文。 */
export function getLastUserMessage(ctx) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i]?.is_user) {
            return String(chat[i].mes ?? '').trim();
        }
    }
    return '';
}

/**
 * 取「上一回合已定稿的助手正文」尾部若干字符，作为文风锚。
 *
 * 排除当前 slot：regenerate / swipe 时最后一条正是要被替换的消息，
 * 不能拿它自己当参考。continue 时最后一条是要续写的正文，正好该用。
 *
 * @param {object} ctx
 * @param {string} generationType
 * @param {number} chars 取尾部多少字符
 */
export function getStyleAnchor(ctx, generationType, chars) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const skipCurrentSlot = generationType === 'regenerate' || generationType === 'swipe';
    const end = skipCurrentSlot ? chat.length - 1 : chat.length;

    for (let i = end - 1; i >= 0; i -= 1) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) continue;
        const text = String(message.mes ?? '').trim();
        if (text) {
            return text.slice(-Math.max(0, chars));
        }
    }
    return '';
}

/**
 * 取当前 slot 的既有正文与 reasoning，供 continue / swipe / regenerate 回滚使用。
 */
export function resolveOriginalSlot(ctx, generationType) {
    if (generationType === 'normal') {
        return { originalText: '', originalReasoning: '' };
    }
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const slot = chat[chat.length - 1];
    return {
        originalText: String(slot?.mes ?? ''),
        originalReasoning: String(slot?.extra?.reasoning ?? ''),
    };
}

// ---------------------------------------------------------------------------
// 编辑原语（自研，刻意不依赖编排器的 editor-ops.js）
// ---------------------------------------------------------------------------

export function appendText(handle, text) {
    if (!text) return;
    handle.setText(handle.getText() + text);
}

export function appendReasoning(handle, text) {
    if (!text) return;
    handle.setReasoning(handle.getReasoning() + text);
}

/**
 * 把 generateTaskStream 的 chunk 流灌进 handle。
 *
 * @param {object} handle createMessageEditorHandle 返回的句柄
 * @param {AsyncIterable<{type:string, delta:string}>} stream
 * @param {{ base?: string, onText?: (full:string)=>void }} [opts]
 *        base —— 前缀不变量要求的原文（continue 时非空）
 * @returns {Promise<string>} 完整的正文（含 base）
 */
export async function pipeStreamIntoHandle(handle, stream, opts = {}) {
    const base = opts.base ?? '';
    let buffer = '';

    for await (const chunk of stream) {
        if (!chunk) continue;
        if (chunk.type === 'text' && chunk.delta) {
            buffer += chunk.delta;
            handle.setText(base + buffer);
            if (typeof opts.onText === 'function') {
                opts.onText(base + buffer);
            }
        } else if (chunk.type === 'reasoning' && chunk.delta) {
            appendReasoning(handle, chunk.delta);
        }
    }

    return base + buffer;
}

// ---------------------------------------------------------------------------
// 文本小助手
// ---------------------------------------------------------------------------

/** 尽力从模型输出里剥出 JSON（容忍 ```json 围栏与前后废话）。 */
export function extractJson(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : raw;

    const direct = tryParseJson(candidate);
    if (direct !== null) return direct;

    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last > first) {
        return tryParseJson(candidate.slice(first, last + 1));
    }
    return null;
}

function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** 裁剪文本到不超过 maxChars，尽量在句末断。 */
export function clampText(text, maxChars) {
    const value = String(text ?? '').trim();
    if (value.length <= maxChars) return value;
    const sliced = value.slice(0, maxChars);
    const cut = Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('\n'), sliced.lastIndexOf('. '));
    return cut > maxChars * 0.6 ? sliced.slice(0, cut + 1) : sliced;
}

/**
 * 判定渲染结果是否疑似被网关阉割 / 拒答 / 退化。
 * 这是 a 动机（怕网关静默阉割）的配套检测——静默失败不检测就发现不了。
 */
export function looksDegenerate(text, intensity) {
    const value = String(text ?? '').trim();
    if (value.length < 24) return '输出过短';

    const head = value.slice(0, 240);
    if (/作为(一个)?\s*(AI|人工智能|语言模型|助手)/i.test(head)) return '出现 AI 自称话术';
    if (/(我)?(无法|不能|不便)(继续|提供|生成|满足|参与)/.test(head)) return '出现拒绝话术';
    if (/I'?m sorry|I can'?t|I cannot|as an AI/i.test(head)) return '出现英文拒绝话术';

    if (Number(intensity) >= 2) {
        // 高强度却被渲染成淡淡带过，通常是上游预设把内容吞了。
        if (value.length < 180) return '高强度段落输出异常简短';
    }
    return null;
}

/** 简易告警（toastr 在 Luker/ST 里全局可用，缺失时降级到 console）。 */
export function notifyWarning(message) {
    try {
        if (globalThis.toastr?.warning) {
            globalThis.toastr.warning(message, 'Multi-Model Roleplay', { timeOut: 6000 });
            return;
        }
    } catch {
        /* noop */
    }
    logWarn(message);
}

/** 信息提示（用于引导用户找到刚挂载的设置面板）。 */
export function notifyInfo(message) {
    try {
        if (globalThis.toastr?.info) {
            globalThis.toastr.info(message, 'Multi-Model Roleplay', { timeOut: 9000 });
            return;
        }
    } catch {
        /* noop */
    }
    logDebug(message);
}
