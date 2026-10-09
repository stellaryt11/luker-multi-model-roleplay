// SPDX-License-Identifier: MIT
/**
 * 自定义 API 连接（端点 + 密钥 + 模型）。
 *
 * 背景
 * ----
 * Luker 的 Connection Profile 已经能覆盖"端点 + 模型"，但**不含密钥** ——
 * 密钥按 API 类型全局存在服务端 `secrets.json` 里。所以"每层用不同的
 * 自建端点 + 不同的密钥"用 Profile 做不到。
 *
 * 本模块补上这一块，全部走官方契约，不碰任何私有状态：
 *
 *   写入密钥：POST /api/secrets/write  { key, value, label } → { id }
 *   使用密钥：apiSettingsOverride.secret_id = id
 *             服务端 readProviderSecret() 会优先读这个 id 对应的 secret
 *   拉取模型：POST /api/backends/chat-completions/status
 *             { chat_completion_source, custom_url, secret_id } → { data: [...] }
 *   注入连接：ctx.generateTask(opts, { _injected: { profileResolver } })
 *
 * 关于 `_injected`：这是 `generateTask` / `generateTaskStream` 的第二个参数，
 * 下划线开头意味着它不是稳定的公开契约。因此本模块**只在某一层确实使用
 * 自定义连接时**才注入 resolver —— 走 Luker Connection Profile 的层完全不受
 * 影响，接口即使变动也只影响自定义模式。
 *
 * 第一版只支持 OpenAI 兼容端点（`chat_completion_source: 'custom'`），
 * 覆盖绝大多数第三方中转；要接 Claude/Gemini 原生协议请用 Connection Profile。
 */

import { logDebug, logWarn } from './utils.js';

/** 自定义连接在设置里的引用前缀，用于与 Luker 的 Profile 名区分。 */
export const CUSTOM_PREFIX = 'custom:';

const SECRET_KEY_SLOT = 'custom';
const STATUS_ENDPOINT = '/api/backends/chat-completions/status';
const SECRETS_WRITE_ENDPOINT = '/api/secrets/write';

export function makeCustomRef(id) {
    return `${CUSTOM_PREFIX}${id}`;
}

export function isCustomRef(value) {
    return String(value ?? '').trim().startsWith(CUSTOM_PREFIX);
}

export function parseCustomRef(value) {
    return String(value ?? '').trim().slice(CUSTOM_PREFIX.length);
}

/** 生成一个稳定的条目 id（不依赖 crypto，够用即可）。 */
export function makeCustomApiId() {
    return `capi_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 按引用查找自定义连接条目。
 *
 * @param {Array} entries 设置里的 customApis
 * @param {string} ref `custom:<id>` 或直接是 id
 */
export function findCustomApi(entries, ref) {
    const id = isCustomRef(ref) ? parseCustomRef(ref) : String(ref ?? '').trim();
    if (!id) return null;
    return (Array.isArray(entries) ? entries : []).find((entry) => entry?.id === id) ?? null;
}

/** 列表展示用名称。 */
export function displayNameOf(entry) {
    const name = String(entry?.name ?? '').trim();
    if (name) return name;
    const model = String(entry?.model ?? '').trim();
    const url = String(entry?.url ?? '').trim();
    return model || url || '未命名连接';
}

// ---------------------------------------------------------------------------
// 密钥
// ---------------------------------------------------------------------------

/**
 * 把 API key 写进 Luker 的服务端 secrets 存储。
 *
 * key 值不会进入插件设置、不会被持久化到 settings.json，也不会返回给前端
 * —— 前端只拿到一个 id。这正是选择这条路的原因。
 *
 * @returns {Promise<string>} secret id（失败时抛错）
 */
export async function writeApiKey(ctx, { value, label }) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) {
        throw new Error('密钥为空');
    }

    const headers = typeof ctx?.getRequestHeaders === 'function'
        ? ctx.getRequestHeaders()
        : { 'Content-Type': 'application/json' };

    const response = await fetch(SECRETS_WRITE_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ key: SECRET_KEY_SLOT, value: trimmed, label: String(label ?? '').trim() }),
    });

    if (!response.ok) {
        throw new Error(`写入密钥失败：HTTP ${response.status}`);
    }

    const data = await response.json().catch(() => null);
    const id = String(data?.id ?? '').trim();
    if (!id) {
        throw new Error('写入密钥失败：服务端未返回 id');
    }

    logDebug('密钥已写入 secrets，id =', id);
    return id;
}

// ---------------------------------------------------------------------------
// 模型列表
// ---------------------------------------------------------------------------

/**
 * 向自定义端点拉取可用模型列表。
 *
 * @param {object} ctx
 * @param {{url: string, secretId?: string}} entry
 * @returns {Promise<string[]>}
 */
export async function fetchModelList(ctx, entry) {
    const url = String(entry?.url ?? '').trim();
    if (!url) {
        throw new Error('请先填写 API 端点');
    }

    const headers = typeof ctx?.getRequestHeaders === 'function'
        ? ctx.getRequestHeaders()
        : { 'Content-Type': 'application/json' };

    const body = {
        chat_completion_source: 'custom',
        custom_url: url,
        base_url: '',
        reverse_proxy: '',
        proxy_password: '',
    };
    const secretId = String(entry?.secretId ?? '').trim();
    if (secretId) {
        body.secret_id = secretId;
    }

    const response = await fetch(STATUS_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-cache',
    });

    if (!response.ok) {
        throw new Error(`模型列表请求失败：HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json().catch(() => null);
    if (data?.error) {
        throw new Error(`模型列表请求失败：${String(data.error?.message ?? data.error)}`);
    }

    const raw = Array.isArray(data?.data) ? data.data : [];
    const models = raw
        .map((item) => (typeof item === 'string' ? item : String(item?.id ?? '')))
        .map((item) => item.trim())
        .filter(Boolean);

    if (!models.length) {
        throw new Error('端点没有返回任何模型（可能是密钥或端点地址不正确）');
    }

    logDebug(`获取到 ${models.length} 个模型`);
    return models;
}

// ---------------------------------------------------------------------------
// 连接注入
// ---------------------------------------------------------------------------

/**
 * 把自定义条目翻译成 `apiSettingsOverride`。
 *
 * 字段名对齐 Connection Profile 的产出（见 connection-manager/profile-resolver.js），
 * 其中 `base_url` 必须显式清空 —— 否则主聊天的 base_url 会串进来。
 */
export function buildApiSettingsOverride(entry) {
    const overrides = {
        chat_completion_source: 'custom',
        custom_url: String(entry?.url ?? '').trim(),
        base_url: '',
    };

    const model = String(entry?.model ?? '').trim();
    if (model) {
        overrides.custom_model = model;
    }

    const secretId = String(entry?.secretId ?? '').trim();
    if (secretId) {
        overrides.secret_id = secretId;
    }

    return overrides;
}

/**
 * 构造一个「只接管自定义引用、其余委托默认解析」的 profileResolver。
 *
 * 委托很重要：同一个回合里可能同时存在用 Connection Profile 的层和用自定义
 * 连接的层，默认解析必须原样工作。
 *
 * @param {object} ctx
 * @param {() => Array} getEntries 返回当前自定义连接列表的函数
 */
export function buildProfileResolver(ctx, getEntries) {
    const defaultResolve = ctx?.connectionProfiles?.resolve;

    return (params = {}) => {
        const profileName = String(params?.profileName ?? '').trim();

        if (!isCustomRef(profileName)) {
            if (typeof defaultResolve !== 'function') {
                logWarn('默认连接解析不可用，且引用不是自定义连接：', profileName);
                return null;
            }
            return defaultResolve(params);
        }

        const entries = typeof getEntries === 'function' ? getEntries() : [];
        const entry = findCustomApi(entries, profileName);
        if (!entry) {
            logWarn(`未找到自定义连接：${profileName}，将回退到当前聊天配置`);
            return null;
        }

        return {
            requestApi: 'openai',
            apiSettingsOverride: buildApiSettingsOverride(entry),
        };
    };
}

/**
 * 为一次 generateTask 调用准备第二个参数。
 *
 * **只在引用是自定义连接时**才返回注入对象 —— 走 Connection Profile 的调用
 * 保持与之前完全一致，不依赖任何半私有接口。
 *
 * @returns {{_injected: object}|undefined}
 */
export function buildInjectionArgs(ctx, settings, apiPresetName) {
    if (!isCustomRef(apiPresetName)) {
        return undefined;
    }

    const entry = findCustomApi(settings?.customApis, apiPresetName);
    if (!entry) {
        logWarn(`自定义连接不存在：${apiPresetName}`);
        return undefined;
    }

    return {
        _injected: {
            profileResolver: buildProfileResolver(ctx, () => settings?.customApis ?? []),
        },
    };
}

/**
 * 校验一条自定义连接是否可用于实际生成。
 * @returns {string|null} 错误信息，null 表示通过
 */
export function validateCustomApi(entry) {
    if (!entry || typeof entry !== 'object') return '连接配置无效';
    if (!String(entry.url ?? '').trim()) return '缺少 API 端点';
    if (!String(entry.secretId ?? '').trim()) return '缺少密钥（请先填写并保存）';
    if (!String(entry.model ?? '').trim()) return '缺少模型名';
    return null;
}
