// SPDX-License-Identifier: MIT
/**
 * 自定义 API 连接模块的单元测试。
 *
 * 这里的断言都对应真实会踩的坑：
 *   - 非自定义引用必须原样委托给 Luker 的默认解析（否则走 Profile 的层会全崩）
 *   - `base_url` 必须显式清空（否则主聊天的 base_url 会串进请求）
 *   - 密钥绝不能落到插件设置里
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CUSTOM_PREFIX,
    buildApiSettingsOverride,
    buildInjectionArgs,
    buildProfileResolver,
    displayNameOf,
    fetchModelList,
    findCustomApi,
    isCustomRef,
    makeCustomApiId,
    makeCustomRef,
    parseCustomRef,
    validateCustomApi,
    writeApiKey,
} from '../src/custom-api.js';

const ENTRY = {
    id: 'capi_1',
    name: '我的中转站',
    url: 'https://relay.example.com/v1',
    secretId: 'secret_abc',
    model: 'gpt-4o-mini',
};

// ── 引用解析 ────────────────────────────────────────────────────────────────

test('自定义引用的构造与解析', () => {
    const ref = makeCustomRef('capi_1');
    assert.equal(ref, `${CUSTOM_PREFIX}capi_1`);
    assert.equal(ref, 'custom:capi_1');
    assert.ok(isCustomRef(ref));
    assert.equal(parseCustomRef(ref), 'capi_1');

    assert.ok(!isCustomRef('my-luker-profile'), 'Luker 的 Profile 名不应被当成自定义');
    assert.ok(!isCustomRef(''), '空串不是自定义');
    assert.ok(!isCustomRef(null));
});

test('生成的 id 唯一且带前缀', () => {
    const a = makeCustomApiId();
    const b = makeCustomApiId();
    assert.notEqual(a, b);
    assert.ok(a.startsWith('capi_'));
});

test('按引用查找条目', () => {
    const entries = [ENTRY, { id: 'capi_2', url: 'https://b/v1' }];
    assert.equal(findCustomApi(entries, 'custom:capi_1')?.id, 'capi_1');
    assert.equal(findCustomApi(entries, 'capi_2')?.id, 'capi_2', '也应接受裸 id');
    assert.equal(findCustomApi(entries, 'custom:nope'), null);
    assert.equal(findCustomApi(null, 'custom:capi_1'), null);
});

test('列表显示名优先级：name > model > url', () => {
    assert.equal(displayNameOf(ENTRY), '我的中转站');
    assert.equal(displayNameOf({ id: 'x', model: 'm1' }), 'm1');
    assert.equal(displayNameOf({ id: 'x', url: 'https://a' }), 'https://a');
    assert.equal(displayNameOf(null), '未命名连接');
});

// ── override 构造 ───────────────────────────────────────────────────────────

test('apiSettingsOverride 字段正确，且 base_url 被显式清空', () => {
    const override = buildApiSettingsOverride(ENTRY);

    assert.equal(override.chat_completion_source, 'custom');
    assert.equal(override.custom_url, 'https://relay.example.com/v1');
    assert.equal(override.custom_model, 'gpt-4o-mini');
    assert.equal(override.secret_id, 'secret_abc');
    assert.equal(override.base_url, '', '必须清空 base_url，否则主聊天配置会串进来');
});

test('缺省字段不会污染 override', () => {
    const override = buildApiSettingsOverride({ url: 'https://a/v1' });
    assert.equal(override.custom_url, 'https://a/v1');
    assert.ok(!Object.hasOwn(override, 'custom_model'), '无模型时不应写入字段');
    assert.ok(!Object.hasOwn(override, 'secret_id'), '无密钥时不写入 secret_id');
});

// ── resolver 委托行为（最关键）──────────────────────────────────────────────

test('非自定义引用原样委托给 Luker 的默认解析', () => {
    const delegated = [];
    const ctx = {
        connectionProfiles: {
            resolve: (params) => {
                delegated.push(params);
                return { requestApi: 'claude', apiSettingsOverride: { marker: 'default' } };
            },
        },
    };

    const resolver = buildProfileResolver(ctx, () => [ENTRY]);
    const result = resolver({ profileName: 'my-luker-profile', defaultApi: 'openai', defaultSource: '' });

    assert.equal(delegated.length, 1, '必须委托，不能自己处理');
    assert.deepEqual(delegated[0], { profileName: 'my-luker-profile', defaultApi: 'openai', defaultSource: '' });
    assert.equal(result.requestApi, 'claude');
    assert.equal(result.apiSettingsOverride.marker, 'default');
});

test('自定义引用走本模块，不触碰默认解析', () => {
    let delegatedCount = 0;
    const ctx = {
        connectionProfiles: {
            resolve: () => {
                delegatedCount += 1;
                return null;
            },
        },
    };

    const resolver = buildProfileResolver(ctx, () => [ENTRY]);
    const result = resolver({ profileName: 'custom:capi_1' });

    assert.equal(delegatedCount, 0, '不应调用默认解析');
    assert.equal(result.requestApi, 'openai');
    assert.equal(result.apiSettingsOverride.custom_url, 'https://relay.example.com/v1');
    assert.equal(result.apiSettingsOverride.secret_id, 'secret_abc');
});

test('找不到自定义条目时返回 null（交由运行时回退）', () => {
    const ctx = { connectionProfiles: { resolve: () => null } };
    const resolver = buildProfileResolver(ctx, () => []);
    assert.equal(resolver({ profileName: 'custom:missing' }), null);
});

test('默认解析不可用时也不抛错', () => {
    const resolver = buildProfileResolver({}, () => [ENTRY]);
    assert.equal(resolver({ profileName: 'some-profile' }), null, '不崩，返回 null');
    assert.ok(resolver({ profileName: 'custom:capi_1' }), '自定义路径仍可用');
});

// ── 注入参数 ────────────────────────────────────────────────────────────────

test('走 Connection Profile 的层完全不注入（不依赖半私有接口）', () => {
    const settings = { customApis: [ENTRY] };
    assert.equal(buildInjectionArgs({}, settings, 'my-luker-profile'), undefined);
    assert.equal(buildInjectionArgs({}, settings, ''), undefined);
    assert.equal(buildInjectionArgs({}, settings, undefined), undefined);
});

test('自定义引用才产生注入参数', () => {
    const settings = { customApis: [ENTRY] };
    const args = buildInjectionArgs({ connectionProfiles: { resolve: () => null } }, settings, 'custom:capi_1');

    assert.ok(args, '应产生注入参数');
    assert.equal(typeof args._injected.profileResolver, 'function');

    const resolved = args._injected.profileResolver({ profileName: 'custom:capi_1' });
    assert.equal(resolved.apiSettingsOverride.custom_model, 'gpt-4o-mini');
});

test('自定义引用指向不存在的条目时不注入', () => {
    const settings = { customApis: [] };
    assert.equal(buildInjectionArgs({}, settings, 'custom:ghost'), undefined);
});

// ── 校验 ────────────────────────────────────────────────────────────────────

test('自定义连接的完整性校验', () => {
    assert.equal(validateCustomApi(ENTRY), null);
    assert.match(validateCustomApi(null), /无效/);
    assert.match(validateCustomApi({ secretId: 's', model: 'm' }), /端点/);
    assert.match(validateCustomApi({ url: 'https://a', model: 'm' }), /密钥/);
    assert.match(validateCustomApi({ url: 'https://a', secretId: 's' }), /模型/);
});

// ── 网络调用（mock fetch）──────────────────────────────────────────────────

function withMockFetch(handler, run) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
        return handler(url, options);
    };
    return Promise.resolve()
        .then(run)
        .finally(() => {
            globalThis.fetch = original;
        })
        .then(() => calls);
}

test('writeApiKey 打到正确端点，且不回传密钥值', async () => {
    const ctx = { getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 't' }) };

    const callsPromise = withMockFetch(
        async () => ({ ok: true, status: 200, json: async () => ({ id: 'secret_xyz' }) }),
        async () => {
            const id = await writeApiKey(ctx, { value: '  sk-test-123  ', label: 'MMRP 场景层' });
            assert.equal(id, 'secret_xyz', '应返回服务端给的 id');
        },
    );
    const calls = await callsPromise;

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/secrets/write');
    assert.equal(calls[0].body.key, 'custom');
    assert.equal(calls[0].body.value, 'sk-test-123', '应去除首尾空白后提交');
    assert.equal(calls[0].body.label, 'MMRP 场景层');
    assert.equal(calls[0].options.headers['X-CSRF-Token'], 't', '应带上 CSRF 头');
});

test('writeApiKey 拒绝空值，不发出请求', async () => {
    let called = 0;
    const ctx = {};
    const callsPromise = withMockFetch(
        async () => {
            called += 1;
            return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
        },
        async () => {
            await assert.rejects(() => writeApiKey(ctx, { value: '   ' }), /密钥为空/);
        },
    );
    await callsPromise;
    assert.equal(called, 0, '空密钥不应发出请求');
});

test('writeApiKey 在服务端不返回 id 时报错', async () => {
    const ctx = {};
    await withMockFetch(
        async () => ({ ok: true, status: 200, json: async () => ({}) }),
        async () => {
            await assert.rejects(() => writeApiKey(ctx, { value: 'sk-x' }), /未返回 id/);
        },
    );
});

test('fetchModelList 解析模型列表', async () => {
    const ctx = { getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) };

    const callsPromise = withMockFetch(
        async () => ({
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'deepseek-chat' }, 'plain-string-model'] }),
        }),
        async () => {
            const models = await fetchModelList(ctx, { url: 'https://relay/v1', secretId: 'secret_abc' });
            assert.deepEqual(models, ['gpt-4o', 'deepseek-chat', 'plain-string-model']);
        },
    );
    const calls = await callsPromise;

    assert.equal(calls[0].url, '/api/backends/chat-completions/status');
    assert.equal(calls[0].body.chat_completion_source, 'custom');
    assert.equal(calls[0].body.custom_url, 'https://relay/v1');
    assert.equal(calls[0].body.secret_id, 'secret_abc', '密钥通过 secret_id 引用，而非明文');
    assert.ok(!('custom_api_key' in calls[0].body), '请求体里不应出现明文密钥');
});

test('fetchModelList 的错误处理', async () => {
    const ctx = {};

    await withMockFetch(
        async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
        async () => {
            await assert.rejects(() => fetchModelList(ctx, { url: 'https://a/v1' }), /没有返回任何模型/);
        },
    );

    await withMockFetch(
        async () => ({ ok: true, status: 200, json: async () => ({ error: { message: 'invalid api key' } }) }),
        async () => {
            await assert.rejects(() => fetchModelList(ctx, { url: 'https://a/v1' }), /invalid api key/);
        },
    );

    await withMockFetch(
        async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) }),
        async () => {
            await assert.rejects(() => fetchModelList(ctx, { url: 'https://a/v1' }), /401/);
        },
    );

    await assert.rejects(() => fetchModelList(ctx, { url: '' }), /请先填写 API 端点/);
});
