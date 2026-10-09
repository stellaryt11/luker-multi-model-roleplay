// SPDX-License-Identifier: MIT
/**
 * 设置读写与设置面板。
 *
 * 设置存放于 extension_settings[MODULE_NAME]，随 Luker 设置一起持久化。
 */

import {
    displayNameOf,
    fetchModelList,
    makeCustomApiId,
    makeCustomRef,
    writeApiKey,
} from './custom-api.js';

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
    /**
     * 准备层（场景/人物/整合）是否使用插件内置的纯净预设。
     *
     * 默认开启。关闭后这三层会跟随当前激活的预设，也就是会吃下你的完整
     * RP 预设（可能上万字的越狱/文风/NSFW 指导）—— 通常不是你想要的。
     */
    prepLayersUsePurePreset: true,
    /** 低强度（日常）渲染 */
    renderLightApiProfile: '',
    renderLightPreset: '',
    /** 高强度渲染（专精模型） */
    renderHeavyApiProfile: '',
    renderHeavyPreset: '',

    // ── 自定义 API 连接（端点 + 密钥 + 模型，与 Connection Profile 二选一）──
    /**
     * 结构：[{ id, name, url, secretId, model }]
     * secretId 由 /api/secrets/write 返回，密钥本体存在服务端，不进本设置。
     */
    customApis: [],

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
    renderCustomApiList();
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

        // 自定义连接与 Connection Profile 并列可选（二选一）
        const entries = ensureCustomApis(settings);
        if (entries.length) {
            const $group = jq('<optgroup>').attr('label', '自定义连接');
            for (const entry of entries) {
                $group.append(jq('<option>').val(makeCustomRef(entry.id)).text(displayNameOf(entry)));
            }
            $select.append($group);
        }

        const known = new Set(profiles.map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean));
        for (const entry of entries) {
            known.add(makeCustomRef(entry.id));
        }

        if (current && !known.has(current)) {
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

    bindCustomApiEvents();
}

// ---------------------------------------------------------------------------
// 自定义 API 连接 UI
// ---------------------------------------------------------------------------

/** 保证 customApis 是结构合法的数组，并补齐缺失的 id。 */
function ensureCustomApis(settings) {
    if (!Array.isArray(settings.customApis)) {
        settings.customApis = [];
    }
    for (const entry of settings.customApis) {
        if (entry && typeof entry === 'object' && !entry.id) {
            entry.id = makeCustomApiId();
        }
    }
    return settings.customApis;
}

function findEntry(settings, id) {
    return ensureCustomApis(settings).find((entry) => entry.id === id) ?? null;
}

/** 重建自定义连接列表。 */
export function renderCustomApiList() {
    const jq = globalThis.jQuery;
    if (!jq) return;
    const $list = jq('#mmrp_custom_api_list');
    if (!$list.length) return;

    const entries = ensureCustomApis(getSettings());

    $list.empty();
    if (!entries.length) {
        $list.append(
            jq('<div class="mmrp-capi-empty">').text(
                '还没有自定义连接。若你已经在 Luker 里建好了 Connection Profile，就不需要这里 —— 直接在上下各层下拉里选即可。',
            ),
        );
        return;
    }

    for (const entry of entries) {
        $list.append(buildCustomApiCard(jq, entry));
    }
}

/** 单张连接卡片。 */
function buildCustomApiCard(jq, entry) {
    const $card = jq('<div class="mmrp-capi-card">').attr('data-id', entry.id);
    const hasKey = Boolean(String(entry.secretId ?? '').trim());

    $card.append(
        jq('<div class="mmrp-capi-head">')
            .append(jq('<input type="text" class="text_pole mmrp-capi-name">')
                .attr('data-field', 'name')
                .attr('placeholder', '名称（仅用于区分）')
                .val(String(entry.name ?? '')))
            .append(jq('<div class="mmrp-capi-del menu_button menu_button_icon">')
                .attr('data-action', 'delete')
                .attr('title', '删除')
                .append(jq('<i class="fa-solid fa-trash">'))),
    );

    $card.append(
        jq('<label class="mmrp-capi-field">')
            .append(jq('<span>').text('API 端点'))
            .append(jq('<input type="text" class="text_pole">')
                .attr('data-field', 'url')
                .attr('placeholder', '例如 https://your-relay.com/v1')
                .val(String(entry.url ?? ''))),
    );

    $card.append(
        jq('<label class="mmrp-capi-field">')
            .append(jq('<span>').text(hasKey ? 'API 密钥（已保存 · 重新填写可覆盖）' : 'API 密钥'))
            .append(jq('<div class="mmrp-capi-inline">')
                .append(jq('<input type="password" class="text_pole">')
                    .attr('data-field', 'key')
                    .attr('placeholder', hasKey ? '已保存，不回显' : 'sk-...')
                    .attr('autocomplete', 'off'))
                .append(jq('<div class="menu_button menu_button_icon mmrp-capi-action">')
                    .attr('data-action', 'save-key')
                    .append(jq('<i class="fa-solid fa-floppy-disk">'))
                    .append(jq('<span>').text('保存密钥')))),
    );

    $card.append(
        jq('<label class="mmrp-capi-field">')
            .append(jq('<span>').text('模型'))
            .append(jq('<div class="mmrp-capi-inline">')
                .append(jq('<input type="text" class="text_pole">')
                    .attr('data-field', 'model')
                    .attr('placeholder', '模型名，例如 gpt-4o-mini')
                    .val(String(entry.model ?? '')))
                .append(jq('<div class="menu_button menu_button_icon mmrp-capi-action">')
                    .attr('data-action', 'fetch-models')
                    .append(jq('<i class="fa-solid fa-download">'))
                    .append(jq('<span>').text('拉取模型')))),
    );

    $card.append(jq('<div class="mmrp-capi-models displayNone">'));
    $card.append(jq('<div class="mmrp-capi-status">'));

    return $card;
}

/** 事件委托（卡片是动态重建的）。 */
function bindCustomApiEvents() {
    const jq = globalThis.jQuery;
    if (!jq) return;

    const $list = jq('#mmrp_custom_api_list');
    if ($list.length) {
        // 字段编辑 → 写回设置（密钥除外，它不落入插件设置）
        $list.off('input.mmrpCapi').on('input.mmrpCapi', 'input[data-field]', function onInput() {
            const $input = jq(this);
            const field = String($input.attr('data-field') ?? '');
            if (field === 'key') return;
            const id = String($input.closest('.mmrp-capi-card').attr('data-id') ?? '');
            const entry = findEntry(getSettings(), id);
            if (!entry) return;
            entry[field] = $input.val();
            persistSettings();
            if (field === 'name') {
                refreshProfileSelects();
            }
        });

        $list.off('click.mmrpCapi').on('click.mmrpCapi', '[data-action]', function onClick(event) {
            event.preventDefault();
            const $button = jq(this);
            const action = String($button.attr('data-action') ?? '');
            const $card = $button.closest('.mmrp-capi-card');
            const id = String($card.attr('data-id') ?? '');

            if (action === 'delete') void deleteCustomApi(id);
            else if (action === 'save-key') void saveCustomApiKey(id, $card);
            else if (action === 'fetch-models') void loadCustomApiModels(id, $card);
        });
    }

    jq('#mmrp_add_custom_api').off('click.mmrpCapi').on('click.mmrpCapi', () => {
        const entries = ensureCustomApis(getSettings());
        entries.push({ id: makeCustomApiId(), name: '', url: '', secretId: '', model: '' });
        persistSettings();
        renderCustomApiList();
        refreshProfileSelects();
    });
}

/** 只刷新各层下拉，不动用户正在编辑的输入框。 */
function refreshProfileSelects() {
    try {
        renderProfileOptions(getSettings());
    } catch (err) {
        logDebug('刷新连接列表失败', err);
    }
}

function setCardStatus($card, text, isError = false) {
    $card.find('.mmrp-capi-status')
        .text(text)
        .toggleClass('mmrp-capi-error', Boolean(isError))
        .toggleClass('mmrp-capi-ok', !isError && Boolean(text));
}

async function saveCustomApiKey(id, $card) {
    const settings = getSettings();
    const entry = findEntry(settings, id);
    if (!entry) return;

    const $input = $card.find('input[data-field="key"]');
    const value = String($input.val() ?? '').trim();
    if (!value) {
        setCardStatus($card, '请先填写密钥', true);
        return;
    }

    setCardStatus($card, '正在写入…');
    try {
        const ctx = getLukerContext();
        const label = `MMRP: ${String(entry.name || entry.url || id)}`;
        entry.secretId = await writeApiKey(ctx, { value, label });
        persistSettings();
        // 重建卡片：既清空输入框，又刷新"已保存"状态
        renderCustomApiList();
        const $fresh = globalThis.jQuery(`.mmrp-capi-card[data-id="${id}"]`);
        setCardStatus($fresh, '密钥已存入 Luker 的 secrets（不在插件设置里）');
    } catch (err) {
        setCardStatus($card, String(err?.message ?? err), true);
    }
}

async function loadCustomApiModels(id, $card) {
    const jq = globalThis.jQuery;
    const settings = getSettings();
    const entry = findEntry(settings, id);
    if (!entry) return;

    const url = String($card.find('input[data-field="url"]').val() ?? '').trim();
    entry.url = url;
    persistSettings();

    if (!url) {
        setCardStatus($card, '请先填写 API 端点', true);
        return;
    }
    if (!String(entry.secretId ?? '').trim()) {
        setCardStatus($card, '请先保存密钥', true);
        return;
    }

    setCardStatus($card, '正在拉取…');
    try {
        const ctx = getLukerContext();
        const models = await fetchModelList(ctx, entry);

        const $box = $card.find('.mmrp-capi-models');
        $box.empty().removeClass('displayNone');

        const $select = jq('<select class="text_pole mmrp-capi-model-select">')
            .append(jq('<option>').val('').text(`选择模型（共 ${models.length} 个）`));
        for (const model of models) {
            $select.append(jq('<option>').val(model).text(model));
        }
        $box.append($select);

        $select.on('change', () => {
            const chosen = String($select.val() ?? '').trim();
            if (!chosen) return;
            entry.model = chosen;
            persistSettings();
            $card.find('input[data-field="model"]').val(chosen);
            setCardStatus($card, `已选择：${chosen}`);
        });

        setCardStatus($card, `拉取成功，共 ${models.length} 个模型`);
    } catch (err) {
        setCardStatus($card, String(err?.message ?? err), true);
    }
}

async function deleteCustomApi(id) {
    const settings = getSettings();
    const entries = ensureCustomApis(settings);
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return;

    const ref = makeCustomRef(id);
    const layers = ['sceneApiProfile', 'actorApiProfile', 'mergeApiProfile', 'renderLightApiProfile', 'renderHeavyApiProfile'];
    const used = layers.filter((key) => String(settings[key] ?? '') === ref);

    const question = used.length
        ? `这条自定义连接正被 ${used.length} 层使用，删除后这些层会回退到当前聊天配置。确定删除？`
        : '确定删除这条自定义连接？（服务端已保存的密钥不会被删除）';

    let confirmed = true;
    try {
        if (typeof globalThis.confirm === 'function') {
            confirmed = globalThis.confirm(question);
        }
    } catch {
        /* 无对话框环境则直接删 */
    }
    if (!confirmed) return;

    entries.splice(index, 1);
    for (const key of used) {
        settings[key] = '';
    }
    persistSettings();
    renderCustomApiList();
    refreshProfileSelects();
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
