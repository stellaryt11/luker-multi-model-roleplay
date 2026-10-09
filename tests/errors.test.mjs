// SPDX-License-Identifier: MIT
/**
 * 错误信息人性化的单元测试。
 *
 * 这些文案是使用者唯一能看到的诊断入口，所以「分得清 401 和 429」、
 * 「认得出非标准端点」本身就是功能，值得锁死。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeFailure, formatFailure } from '../src/errors.js';

function makeError(message, extra = {}) {
    return Object.assign(new Error(message), extra);
}

test('401 被识别为鉴权失败，并指向密钥/端点', () => {
    const result = describeFailure(makeError(
        'auth error: Got response status 401 from : {"error":"Unauthorized: Please make sure you\'re using the latest version of Cline and re-authenticate your Cline account."}',
    ));
    assert.match(result.title, /鉴权失败/);
    assert.match(result.detail, /密钥|端点/);
});

test('错误码优先于文案', () => {
    const error = makeError('something completely different');
    error.code = 'auth_missing';
    assert.match(describeFailure(error).title, /鉴权失败/);
});

test('429 / 403 / 400 / 404 / 5xx 各自归类', () => {
    assert.match(describeFailure(makeError('Got response status 429 Too Many Requests')).title, /限流/);
    assert.match(describeFailure(makeError('403 Forbidden')).title, /被拒绝/);
    assert.match(describeFailure(makeError('400 Bad Request: invalid model')).title, /请求被拒绝/);
    assert.match(describeFailure(makeError('404 model_not_found')).title, /不存在/);
    assert.match(describeFailure(makeError('502 Bad Gateway')).title, /服务端错误/);
});

test('「返回了非标准响应」会指出端点是客户端专用 API', () => {
    const result = describeFailure(makeError('openai sender returned no choices'));
    assert.match(result.title, /非标准响应/);
    assert.match(result.detail, /OpenAI 兼容|专用 API/);

    // 错误码路径同样命中
    const coded = makeError('whatever');
    coded.code = 'no_response';
    assert.match(describeFailure(coded).title, /非标准响应/);
});

test('网络类错误被归一', () => {
    for (const message of ['fetch failed', 'ECONNREFUSED 127.0.0.1:443', 'ENOTFOUND api.example.com']) {
        assert.match(describeFailure(makeError(message)).title, /网络/, message);
    }
});

test('无法归类时退化为原始信息，而不是空话', () => {
    const result = describeFailure(makeError('某个非常奇怪的自定义错误'));
    assert.equal(result.title, '调用失败');
    assert.match(result.detail, /非常奇怪/);
});

test('空输入不抛错', () => {
    for (const input of [null, undefined, '字符串错误', 42]) {
        const result = describeFailure(input);
        assert.ok(result.title, `title 不能为空：${String(input)}`);
        assert.equal(typeof result.detail, 'string');
    }
});

test('层名会被带上（多模型下「哪一层」是第一信息）', () => {
    const error = makeError('Got response status 401');
    error.mmrpLayer = '人物层';

    const result = describeFailure(error);
    assert.equal(result.layer, '人物层');
    assert.match(formatFailure(error), /「人物层」/);
    assert.match(formatFailure(error), /鉴权失败/);
});

test('formatFailure 在没有层名时不产生空引号', () => {
    const text = formatFailure(makeError('429 Too Many Requests'));
    assert.ok(!text.includes('「」'), text);
    assert.match(text, /限流/);
});
