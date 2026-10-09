// SPDX-License-Identifier: MIT
/**
 * 把底层技术错误翻译成人能看懂的话。
 *
 * 动机：`GenerateTaskError: auth error: Got response status 401 from...`
 * 这种信息对使用者的意义接近于零 —— 他不知道是哪一层、为什么、该改什么。
 * 多模型架构下尤其重要，因为四层用的是四个不同的连接，出问题时"哪一层"
 * 是第一件必须知道的事。
 */

/** 人话描述。 */
const DESCRIPTORS = [
    {
        match: (code, text) => code === 'auth_missing' || /\b401\b|unauthor|invalid api key|incorrect api key|authentication/i.test(text),
        title: '鉴权失败（401）',
        detail: '这一层的 API 密钥或端点不正确。请到对应连接配置里确认密钥有效、端点确实是你要用的那家服务。',
    },
    {
        match: (code, text) => code === 'rate_limit' || /\b429\b|rate.?limit|too many requests/i.test(text),
        title: '触发限流（429）',
        detail: '稍后再试，或降低该层的请求频率。也可能是该密钥的额度用完了。',
    },
    {
        match: (code, text) => code === 'network' || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network error/i.test(text),
        title: '网络不可达',
        detail: '端点地址连不上。检查地址是否正确、是否需要代理、服务是否在运行。',
    },
    {
        match: (code, text) => /\b403\b|forbidden/i.test(text),
        title: '被拒绝（403）',
        detail: '密钥有效但无权访问该模型或该端点。检查账号权限与模型名。',
    },
    {
        match: (code, text) => code === 'no_response' || /no choices|no_response/i.test(text),
        title: '端点返回了非标准响应',
        detail: '响应里没有 choices，说明它可能不是 OpenAI 兼容接口 —— 例如某个客户端（Cline、Cursor 等）的专用 API，需要该客户端自己的认证方式。请换成标准兼容端点。',
    },
    {
        match: (code, text) => code === 'json_schema_violation' || /unrecognized shape|response_format|json_schema/i.test(text),
        title: '端点不支持结构化输出',
        detail: '可在设置里关闭「请求结构化输出」，插件会自动改用纯提示词约束。',
    },
    {
        match: (code, text) => /\b400\b|invalid_request|bad request/i.test(text),
        title: '请求被拒绝（400）',
        detail: '端点不接受本次请求的参数。常见原因是模型名不存在，或该模型不支持某些参数。',
    },
    {
        match: (code, text) => /\b404\b|not found|model_not_found/i.test(text),
        title: '模型或路径不存在（404）',
        detail: '检查模型名拼写，以及端点路径是否正确（很多服务需要以 /v1 结尾）。',
    },
    {
        match: (code, text) => /\b500\b|\b502\b|\b503\b|internal server error|bad gateway|service unavailable/i.test(text),
        title: '服务端错误（5xx）',
        detail: '对方服务出了问题，通常重试即可；持续失败则换端点。',
    },
    {
        match: (code, text) => code === 'invalid_input' || /invalid_input|mutually exclusive/i.test(text),
        title: '插件构造的请求不合法',
        detail: '这是插件的内部错误，请把日志反馈给作者。',
    },
    {
        match: (code, text) => code === 'unsupported_api' || /unsupported_api|stream_unavailable/i.test(text),
        title: '该端点不支持所需能力',
        detail: '例如非 OpenAI 家族不支持流式输出。可以给这一层换一个 OpenAI 兼容端点。',
    },
];

/**
 * @param {unknown} error
 * @returns {{title: string, detail: string, layer: string}}
 */
export function describeFailure(error) {
    const code = String(error?.code ?? '').trim();
    const layer = String(error?.mmrpLayer ?? '').trim();

    const message = String(error?.message ?? '');
    const cause = String(error?.cause?.message ?? '');
    const text = `${message} ${cause}`;

    for (const descriptor of DESCRIPTORS) {
        if (descriptor.match(code, text)) {
            return { title: descriptor.title, detail: descriptor.detail, layer };
        }
    }

    return {
        title: '调用失败',
        detail: message.slice(0, 300) || '未知错误',
        layer,
    };
}

/** 组装成一行给 toastr / 日志用的文本。 */
export function formatFailure(error) {
    const { title, detail, layer } = describeFailure(error);
    const prefix = layer ? `「${layer}」` : '';
    return `${prefix}${title}${detail ? ` —— ${detail}` : ''}`;
}
