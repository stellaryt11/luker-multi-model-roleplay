// SPDX-License-Identifier: MIT
/**
 * Multi-Model Roleplay —— Luker 插件入口。
 *
 * 把一次对话拆给多个模型协作完成：
 *   ① 场景层（模型 A）—— 构建世界的事实
 *   ② 人物层（模型 B）—— 裁决角色的回应与 NSFW 强度
 *   ③ 整合层（模型 C）—— 合并为渲染指令
 *   ④ 渲染层（模型 D，按强度分档）—— 唯一的正文作者
 *
 * 依赖 Luker 独有的消息接管机制（GENERATE_TAKEOVER_DISPATCH）。
 * 在原生 SillyTavern 上会安全禁用，不会破坏对方环境。
 *
 * 本文件刻意不 import 任何 Luker 核心模块，全部走全局 Luker.getContext()，
 * 以避免与 AGPL 代码产生链接，并抵御核心模块路径变动。
 */

import { runPipeline, isAbort } from './src/pipeline.js';
import { getSettings, mountSettingsPanel } from './src/settings.js';
import {
    MODULE_NAME,
    getLukerContext,
    logDebug,
    logError,
    logWarn,
    notifyWarning,
    probeCapabilities,
    resolveOriginalSlot,
    setDebugEnabled,
} from './src/utils.js';

let registered = false;
let initialized = false;

const PLUGIN_VERSION = '0.1.1';

/**
 * activate 钩子（manifest.hooks.activate）。
 * 必须快速返回 —— 内核给它 5 秒超时。
 *
 * 幂等：顶层自启动与平台 hooks 可能先后各调一次，只有第一次生效。
 */
export function init() {
    if (initialized) {
        logDebug('init 重复调用，已忽略');
        return;
    }
    initialized = true;

    // 这条日志不受调试开关控制 —— 它是排查「插件到底有没有加载」的第一手线索。
    console.log(
        `%c[${MODULE_NAME}]%c v${PLUGIN_VERSION} 初始化中…`,
        'background:#7b53c1;color:#fff;padding:1px 4px;border-radius:3px',
        'color:#7b53c1',
    );

    const probe = probeCapabilities();

    if (!probe.ok) {
        if (!probe.ctx) {
            console.warn(`[${MODULE_NAME}] 未检测到 Luker context —— 插件保持休眠（可能运行在原生 SillyTavern 或非 UI 环境）`);
        } else {
            console.warn(
                `[${MODULE_NAME}] 当前环境缺少 Luker 消息接管能力，插件已禁用。缺失：`,
                probe.missing.join('、'),
            );
        }
        scheduleSettingsPanel();
        installDiagnostics();
        return;
    }

    registerTakeover();
    installDiagnostics();
    scheduleSettingsPanel();
    console.log(`[${MODULE_NAME}] v${PLUGIN_VERSION} 已就绪`);
}

/**
 * 注册全局诊断入口。
 *
 * 用户在浏览器控制台执行 `mmrpDiagnose()` 就能拿到完整的加载状态，
 * 不用去猜「面板到底挂上没挂上」。报障时把返回值发过来即可。
 */
function installDiagnostics() {
    globalThis.mmrpDiagnose = () => {
        const $ = globalThis.jQuery;
        const ctx = getLukerContext();
        const probe = probeCapabilities();
        const count = (selector) => {
            if (!$) return 0;
            try {
                return $(selector).length;
            } catch {
                return 0;
            }
        };

        const report = {
            插件版本: PLUGIN_VERSION,
            已初始化: initialized,
            接管监听已注册: registered,
            运行环境: ctx ? 'Luker（context 可用）' : '非 Luker / 无 context',
            能力检测: probe.ok ? '通过' : `缺少：${probe.missing.join('、')}`,
            设置面板DOM: count('#mmrp_settings_block') ? '已挂载（面板存在）' : '未找到（挂载失败）',
            可用挂载容器: {
                '#extensions_settings': count('#extensions_settings'),
                '#extensions_settings2': count('#extensions_settings2'),
                '.extensions_block': count('.extensions_block'),
            },
            当前设置: getSettings(),
        };

        console.log(`[${MODULE_NAME}] 诊断报告`, report);
        if (report['设置面板DOM'].startsWith('未找到')) {
            console.log(
                `[${MODULE_NAME}] 提示：面板应位于左侧「扩展」抽屉（立方体图标）内，` +
                '通常需要往下滚动。若容器计数均为 0，说明当前页面结构不匹配，请把本报告发回。',
            );
        }
        return report;
    };

    console.log(`[${MODULE_NAME}] 可在控制台执行 mmrpDiagnose() 查看诊断信息`);
}

/**
 * 顶层自启动（双保险）。
 *
 * 不依赖平台的 hooks 机制：模块被 import 时就把初始化排进 DOM ready 队列。
 * 这样即使某个 Luker/SillyTavern 版本不读 manifest 的 hooks 字段，
 * 面板与接管监听依然会正常建立。
 */
function scheduleAutoInit() {
    const run = () => {
        try {
            init();
        } catch (err) {
            console.error(`[${MODULE_NAME}] 自启动失败`, err);
        }
    };

    if (globalThis.jQuery) {
        globalThis.jQuery(run);
        return;
    }
    if (globalThis.document) {
        if (globalThis.document.readyState === 'loading') {
            globalThis.document.addEventListener('DOMContentLoaded', run, { once: true });
        } else {
            run();
        }
    }
    // 无 DOM 的运行环境（单元测试）不自动初始化，由调用方显式调用 init()。
}

scheduleAutoInit();

/** 面板挂载异步进行，不阻塞 activate 钩子。 */
function scheduleSettingsPanel() {
    const mount = () => {
        mountSettingsPanel().catch((err) => logError('挂载设置面板失败', err));
    };
    if (globalThis.jQuery) {
        globalThis.jQuery(mount);
    } else {
        globalThis.setTimeout(mount, 800);
    }
}

/** 注册消息接管监听（幂等）。 */
function registerTakeover() {
    if (registered) return;

    const ctx = getLukerContext();
    if (!ctx?.eventSource?.on) {
        logWarn('eventSource 不可用，无法注册接管监听');
        return;
    }

    ctx.eventSource.on(ctx.eventTypes.GENERATE_TAKEOVER_DISPATCH, handleDispatch);
    registered = true;
    logDebug('已注册 GENERATE_TAKEOVER_DISPATCH 监听');
}

/**
 * 接管处理器。
 *
 * 刻意写成同步函数：必须在任何 await 之前完成 takeoverHandle 赋值，
 * 否则会被其他订阅方抢先（文档明确说明「先到先得」）。
 */
function handleDispatch(eventData) {
    try {
        const settings = getSettings();
        setDebugEnabled(Boolean(settings.debug));

        if (!settings.enabled) {
            logDebug('插件未启用，跳过接管');
            return;
        }

        if (!eventData) return;

        // 已有订阅方接管（例如编排器的 Director 模式）。
        if (eventData.takeoverHandle) {
            if (settings.conflictPolicy !== 'claim') {
                logDebug('已有其他插件声明接管，按设置让出本回合');
                return;
            }
            logWarn('检测到已有接管者，按设置抢占本回合（可能导致编排器无输出）');
        }

        const ctx = getLukerContext();
        if (!ctx) return;

        const generationType = String(eventData.type ?? '');
        if (!['normal', 'regenerate', 'swipe', 'continue'].includes(generationType)) {
            logDebug(`不处理的生成类型：${generationType}`);
            return;
        }

        // continue / swipe / regenerate 需要读回原 slot 内容以便内核正确回滚
        const { originalText, originalReasoning } = resolveOriginalSlot(ctx, generationType);

        const handle = ctx.createMessageEditorHandle({
            generationType,
            originalText,
            originalReasoning,
            abortSignal: eventData.abortSignal,
            owner: MODULE_NAME,
        });

        // ← 这一步必须在同步路径上完成
        eventData.takeoverHandle = handle;

        // 启动流水线；内核会 await handle.complete，我们不需要自己等。
        void drivePipeline({ ctx, eventData, handle, settings, generationType });
    } catch (err) {
        logError('接管声明失败，本回合交回主 LLM', err);
    }
}

/**
 * 驱动流水线并在正确的终态上结算句柄。
 * 三种终态互斥，必须恰好调一个 —— 选错会和下一回合产生竞态。
 */
async function drivePipeline({ ctx, eventData, handle, settings, generationType }) {
    const started = Date.now();
    try {
        const result = await runPipeline({ ctx, eventData, handle, settings });

        logDebug('流水线完成', {
            ms: Date.now() - started,
            intensity: result.intensity,
            renderTier: result.renderTier,
            timings: result.timings,
        });

        // 自然完成 → 完整 finalize pipeline（触发事件、跑正则、持久化、autoContinue）
        await handle.commit();
    } catch (err) {
        if (isAbort(err, eventData.abortSignal)) {
            // 用户点了停止：保留已经流出来的部分，但跳过 finalize pipeline，
            // 否则会与用户接下来点的 regenerate 撞车。
            logDebug('用户取消，保留已生成内容');
            try {
                await handle.abort();
            } catch (abortErr) {
                logWarn('abort 结算失败', abortErr);
            }
            return;
        }

        logError('流水线失败，回滚本回合', err);
        const message = String(err?.message ?? err ?? '未知错误');
        notifyWarning(`多模型流水线失败，已回滚本回合：${message}`);
        try {
            // 没有可用 partial 的硬失败 → 恢复 slot 原状
            await handle.discard();
        } catch (discardErr) {
            logWarn('discard 结算失败', discardErr);
        }
    }
}
