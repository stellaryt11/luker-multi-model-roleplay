// SPDX-License-Identifier: MIT
/**
 * 设置面板与设置模型的静态一致性检查。
 *
 * 防的是这类真实低级的错误：加了一个设置字段却忘了给它加控件、
 * 改了控件名却没改设置键、或者两份 key 列表悄悄漂移。这类问题不会报错，
 * 只会表现为"某个选项怎么调都没反应"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, ROOT)), 'utf8');

/**
 * 没有 data-setting 控件、由代码动态渲染的设置项。
 * 每加一项都要在这里说明理由，避免白名单变成垃圾桶。
 */
const DYNAMIC_SETTINGS = new Set([
    'customApis', // 自定义连接是多条记录，由 renderCustomApiList() 动态渲染
]);

/** 只用于 UI 状态、不需要控件的键（预留）。 */
const UI_ONLY_SETTINGS = new Set([]);

function extractHtmlSettingKeys() {
    const html = read('settings.html');
    const keys = [...html.matchAll(/data-setting="([^"]+)"/g)].map((m) => m[1]);
    return keys;
}

function extractDefaultSettingKeys() {
    const source = read('src/settings.js');
    const block = source.split('export const DEFAULT_SETTINGS')[1]?.split('\n};')[0] ?? '';

    // 匹配顶层键：缩进 4 空格 + 标识符 + 冒号
    const keys = [];
    for (const line of block.split('\n')) {
        const match = line.match(/^ {4}([A-Za-z_$][\w$]*):/);
        if (match) keys.push(match[1]);
    }
    return keys;
}

test('面板里的每个控件都能找到对应的设置项', () => {
    const htmlKeys = extractHtmlSettingKeys();
    const defaultKeys = new Set(extractDefaultSettingKeys());

    const orphans = htmlKeys.filter((key) => !defaultKeys.has(key));
    assert.deepEqual(orphans, [], `面板上存在没有对应设置项的控件：${orphans.join('、')}`);
});

test('每个设置项都有控件，除非明确登记为动态渲染', () => {
    const htmlKeys = new Set(extractHtmlSettingKeys());
    const defaultKeys = extractDefaultSettingKeys();

    const missing = defaultKeys.filter(
        (key) => !htmlKeys.has(key) && !DYNAMIC_SETTINGS.has(key) && !UI_ONLY_SETTINGS.has(key),
    );
    assert.deepEqual(missing, [], `这些设置项没有面板控件：${missing.join('、')}`);
});

test('面板里的 data-setting 不重复', () => {
    const htmlKeys = extractHtmlSettingKeys();
    const seen = new Set();
    const duplicates = [];
    for (const key of htmlKeys) {
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
    }
    assert.deepEqual(duplicates, [], `重复的控件：${duplicates.join('、')}`);
});

test('settings.html 的 div 标签配对', () => {
    const html = read('settings.html');
    const open = (html.match(/<div\b/g) ?? []).length;
    const close = (html.match(/<\/div>/g) ?? []).length;
    assert.equal(open, close, `div 开合不匹配：开 ${open} 个，闭 ${close} 个`);
});

test('默认设置里的自定义连接初始为空数组', () => {
    const source = read('src/settings.js');
    assert.match(
        source,
        /customApis:\s*\[\s*\]/,
        'customApis 必须以空数组初始化，否则 UI 会在首次渲染时拿到 undefined',
    );
});

test('纯净预设开关默认开启', () => {
    const source = read('src/settings.js');
    assert.match(
        source,
        /prepLayersUsePurePreset:\s*true/,
        '纯净预设必须默认开启 —— 默认关闭会让准备层直接吃下用户的完整 RP 预设',
    );
});
