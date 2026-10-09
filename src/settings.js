// SPDX-License-Identifier: MIT
/**
 * 设置读写与设置面板。
 *
 * 设置存放于 extension_settings[MODULE_NAME]，随 Luker 设置一起持久化。
 */

import {
    MODULE_NAME,
    PLUGIN_ROOT_URL,
    getLukerContext,
    logDebug,
    logError,
    notifyInfo,
    notifyWarning,
    probeCapabilities,
    setDebugEnabled,
} from './utils.js';

export const DEFAULT_SETTINGS = {
    enabled: false,

    // ── 四层各自的 Connection Profile（模型路由）与 chat completion 预设 ──
    sceneApiProfile: '',
    scenePreset: '',
    actorApiProfile: '',
    actorPreset: '',
    mergeApiProfile: '',
    mergePreset: '',
    /** 低强度（日常）渲染 */
    renderLightApiProfile: '',
    renderLightPreset: '',
    /** 高强度渲染（专精模型） */
    renderHeavyApiProfile: '',
    renderHeavyPreset: '',

    // ── 强度路由（按回合）──
    /** nsfw_intensity >= 该值则整条消息交给 heavy 渲染器 */
    nsfwThreshold: 2,
    /** heavy 未配置时是否回退到 light */
    heavyFallbackToLight: true,

    // ── 上下文预算 ──
    recentMessageCount: 12,
    styleAnchorChars: 600,
    styleAnchorEnabled: true,

    // ── 健壮性 ──
    /** 渲染结果疑似被阉割时自动重试一次 */
    retryOnDegenerate: true,
    /** 基础请求超时（毫秒），0 = 不额外限制 */
    requestTimeoutMs: 180000,
    /** 准备阶段是否显示进度占位（场景构建中 / 裁决中 / 整合中） */
    showProgress: true,
    /**
     * 与其它接管者的冲突策略：
     *   'yield' —— 有别的插件先接管就让出本回合（默认，安全）
     *   'claim' —— 抢占本回合（可能让编排器无输出）
     */
    conflictPolicy: 'yield',

    // ── 提示词覆盖（留空则用内置默认）──
    sceneSystemOverride: '',
    actorSystemOverride: '',
    mergeSystemOverride: '',
    renderLightSystemOverride: '',
    renderHeavySystemOverride: '',

    debug: false,
};

/** 读取设置（补齐缺失字段，返回活对象）。 */
export function getSettings() {
    const ctx = getLukerContext();
    if (!ctx) return { ...DEFAULT_SETTINGS };

    const store = ctx.extensionSettings;
    if (!store) return { ...DEFAULT_SETTINGS };

    store[MODULE_NAME] = store[MODULE_NAME] || {};
    const settings = store[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }
    return settings;
}

/** 触发 Luker 侧保存（失败不致命，设置最终会随会话一起落盘）。 */
export function persistSettings() {
    const ctx = getLukerContext();
    try {
        ctx?.saveSettingsDebounced?.();
    } catch (err) {
        logDebug('保存设置失败（非致命）', err);
    }
}

// ---------------------------------------------------------------------------
// 设置面板
// ---------------------------------------------------------------------------

export async function mountSettingsPanel() {
    if (!globalThis.jQuery) {
        // 非 UI 环境（测试 / 无 DOM）——不必报错
        logDebug('无 jQuery，跳过设置面板挂载');
        return;
    }

    if (globalThis.jQuery('#mmrp_settings_block').length) {
        return; // 已挂载
    }

    const found = findMountHost();
    if (!found) {
        const message = '找不到扩展设置面板的挂载容器（已尝试 #extensions_settings、#extensions_settings2、.extensions_block）';
        logError(message);
        notifyWarning(`${message}，设置面板未能显示。`);
        return;
    }

    const settings = getSettings();
    let html;
    try {
        const url = `${PLUGIN_ROOT_URL}settings.html`;
        logDebug(`加载设置面板：${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        html = await response.text();
    } catch (err) {
        const message = `加载 settings.html 失败（${PLUGIN_ROOT_URL}settings.html）：${err?.message ?? err}`;
        logError(message);
        notifyWarning(message);
        return;
    }

    found.host.append(html);
    renderProfileOptions(settings);
    bindSettingsInputs(settings);
    updateCapabilityNotice();

    console.log(`[${MODULE_NAME}] 设置面板已挂载到 ${found.selector}`);
    notifyInfo('设置面板已就绪 —— 在左侧「扩展」抽屉（立方体图标）里可以找到；找不到就往下滚动。');
}

/**
 * 依次尝试已知的扩展设置容器。
 * Luker 的内部扩展用 #extensions_settings2，第三方扩展沿用 SillyTavern 的
 * #extensions_settings；两者都在扩展抽屉里。
 */
function findMountHost() {
    const jq = globalThis.jQuery;
    const candidates = [
        '#extensions_settings',
        '#extensions_settings2',
        '.extensions_block',
        '#rm_extensions_block',
    ];
    for (const selector of candidates) {
        try {
            const host = jq(selector);
            if (host.length) {
                return { host, selector };
            }
        } catch (err) {
            logDebug(`选择器 ${selector} 查询失败`, err);
        }
    }
    return null;
}

/** 用当前可用的 Connection Profile 填充各个下拉框。 */
function renderProfileOptions(settings) {
    const jq = globalThis.jQuery;
    if (!jq) return;

    let profiles = [];
    try {
        const ctx = getLukerContext();
        profiles = ctx?.connectionProfiles?.list?.() ?? [];
    } catch (err) {
        logDebug('读取 Connection Profile 列表失败', err);
    }

    jq('.mmrp-profile-select').each(function eachSelect() {
        const $select = jq(this);
        const key = $select.data('setting');
        const current = String(settings[key] ?? '');
        const $options = jq('<option>').val('').text('（跟随当前聊天 API 配置）');
        $select.empty().append($options);

        for (const profile of profiles) {
            const name = typeof profile === 'string' ? profile : profile?.name;
            if (!name) continue;
            $select.append(jq('<option>').val(name).text(name));
        }

        if (current && !profiles.some((p) => (typeof p === 'string' ? p : p?.name) === current)) {
            // 保留失效的旧值，避免用户无声丢失配置
            $select.append(jq('<option>').val(current).text(`${current}（当前不可用）`));
        }
        $select.val(current);
    });
}

function bindSettingsInputs(settings) {
    const jq = globalThis.jQuery;
    if (!jq) return;

    jq('#mmrp_settings_block [data-setting]').each(function eachInput() {
        const $input = jq(this);
        const key = $input.data('setting');
        const isCheckbox = $input.attr('type') === 'checkbox';
        const isNumber = $input.attr('type') === 'number';

        if (isCheckbox) {
            $input.prop('checked', Boolean(settings[key]));
        } else {
            $input.val(settings[key] ?? '');
        }

        $input.on('change input', () => {
            let value;
            if (isCheckbox) value = $input.prop('checked');
            else if (isNumber) value = Number($input.val()) || 0;
            else value = $input.val();

            settings[key] = value;
            if (key === 'debug') {
                setDebugEnabled(value);
            }
            persistSettings();
        });
    });

    jq('#mmrp_refresh_profiles').on('click', () => {
        renderProfileOptions(getSettings());
    });
}

/**
 * 把能力检测结果显示在面板上。
 * 在纯 SillyTavern 上运行时必须给出明确提示并保持禁用，而不是静默失败。
 */
export function updateCapabilityNotice() {
    const jq = globalThis.jQuery;
    if (!jq) return;
    const $notice = jq('#mmrp_capability_notice');
    if (!$notice.length) return;

    const result = probeCapabilities();
    if (result.ok) {
        $notice.addClass('displayNone');
        return;
    }
    $notice.removeClass('displayNone').text(
        `当前环境缺少 Luker 的消息接管能力（${result.missing.join('、')}），插件已自动禁用。` +
        '本插件依赖 Luker 独有的 GENERATE_TAKEOVER_DISPATCH 机制，无法在原生 SillyTavern 上运行。',
    );
}
