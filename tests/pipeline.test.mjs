// SPDX-License-Identifier: MIT
/**
 * 端到端流水线测试 —— 用模拟的 Luker 环境验证四层协作、强度路由与终态结算。
 *
 * 这里的每条断言都对应一个真实会踩到的坑：
 * 终态选错会和下一回合竞态、强度被上游越权上调会破坏路由、
 * continue 前缀丢失会吃掉用户想续写的内容。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockContext, loadPluginWithContext } from './helpers/mock-luker.mjs';

// ── 固定素材 ────────────────────────────────────────────────────────────────

const SCENE_JSON = JSON.stringify({
    time_place: '深夜，公寓玄关',
    environment: '雨声压着窗玻璃，玄关灯没开，只有厨房的余光',
    npc_motion: ['林晚刚进门，正在收伞'],
    world_events: ['楼下的雨越下越大'],
    hard_constraints: ['大门已经从内侧上了插销', '客厅的灯是坏的'],
    anchors: ['墙角的伞架', '玄关的鞋柜'],
});

const MERGE_JSON = (intensity) => JSON.stringify({
    pov: '第三人称限制视角',
    tense: '过去时',
    voice_notes: '克制、感官细节优先',
    render_blocks: [
        { type: 'env', intent: '写雨声与昏暗的光线', constraints: '不要引入新场景' },
        { type: 'action', intent: '林晚收伞的动作' },
        { type: 'dialogue', intent: '一句简短的招呼', constraints: '贴合她的疏离感' },
    ],
    continuity: '承接上一回合她在门口站定的画面',
    forbidden: ['AI 自称', '数据化措辞'],
    nsfw_intensity: intensity,
});

const ACTOR_JSON = (intensity) => JSON.stringify({
    beats: ['把伞靠到墙角', '踢掉鞋', '抬眼看过来'],
    action: '收伞、换鞋、看向对方',
    dialogue_intent: ['用一个短句回应，语气疏离但不冷漠'],
    inner_state: '疲惫，但有一丝放松',
    emotion: '疲惫而松弛',
    constraint_notes: ['客厅灯坏了，所以她不打算往客厅走'],
    nsfw_intensity: intensity,
    intensity_reason: intensity >= 2 ? '双方已经明确进入亲密情境' : '本回合是日常互动',
});

const LONG_PROSE = (
    '她把伞靠在墙角，水顺着伞骨淌下来，在地砖上洇出一小片深色。玄关的灯没开，'
    + '只有厨房那点余光斜斜地切过来，落在她半侧的脸上。她踢掉鞋，动作很轻，像是不想'
    + '惊动这间屋子里任何一件还在睡着的东西。然后她抬起头，目光在你脸上停了一瞬，'
    + '又移开了。\n\n「回来了。」她说，声音比雨声还要低一点。'
).repeat(2);

const SHORT_PROSE = '好吧。';

/** 组织一次标准运行的公共设置。 */
function makeSettings(overrides = {}) {
    return {
        enabled: true,
        sceneApiProfile: 'scene-model',
        actorApiProfile: 'actor-model',
        mergeApiProfile: 'merge-model',
        renderLightApiProfile: 'render-light',
        renderHeavyApiProfile: 'render-heavy',
        nsfwThreshold: 2,
        requestTimeoutMs: 0,
        ...overrides,
    };
}

/** 注入设置对象（插件从 context.extensionSettings 读取）。 */
function seedSettings(harness, settings) {
    harness.ctx.extensionSettings['multi-model-roleplay'] = { ...settings };
}

// ── 1. 启用与冲突策略 ───────────────────────────────────────────────────────

test('未启用时不声明接管', async () => {
    const harness = createMockContext();
    seedSettings(harness, makeSettings({ enabled: false }));
    await loadPluginWithContext(harness.ctx);

    const payload = harness.dispatch({});
    assert.equal(payload.takeoverHandle, null, '未启用时不应接管');
    assert.equal(harness.handles.length, 0, '不应创建句柄');
});

test('已有其它接管者时按默认策略让出本回合', async () => {
    const harness = createMockContext();
    seedSettings(harness, makeSettings());
    await loadPluginWithContext(harness.ctx);

    const existing = { fake: 'orchestrator-handle' };
    const payload = harness.dispatch({ takeoverHandle: existing });

    assert.equal(payload.takeoverHandle, existing, '不应覆盖已有接管者');
    assert.equal(harness.handles.length, 0);
});

test('conflictPolicy=claim 时抢占本回合', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(0), merge: MERGE_JSON(0), render: LONG_PROSE },
    });
    seedSettings(harness, makeSettings({ conflictPolicy: 'claim' }));
    await loadPluginWithContext(harness.ctx);

    const payload = harness.dispatch({ takeoverHandle: { fake: true } });
    assert.ok(payload.takeoverHandle, '应抢占');
    assert.ok(harness.handles.length === 1, '应创建自己的句柄');

    await harness.handles[0].complete;
    assert.equal(harness.handles[0]._state.status, 'committed');
});

// ── 2. 正常四层流水线与终态 ─────────────────────────────────────────────────

test('normal 类型：四层依次执行并 commit', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(0), merge: MERGE_JSON(0), render: LONG_PROSE },
    });
    seedSettings(harness, makeSettings());
    await loadPluginWithContext(harness.ctx);

    const payload = harness.dispatch({ type: 'normal' });
    const handle = payload.takeoverHandle;
    assert.ok(handle, '应接管');

    const settled = await handle.complete;

    assert.equal(settled.status, 'committed', '自然完成应 commit');
    assert.equal(harness.calls.scene.length, 1, '场景层应调用一次');
    assert.equal(harness.calls.actor.length, 1, '人物层应调用一次');
    assert.equal(harness.calls.merge.length, 1, '整合层应调用一次');
    assert.equal(harness.calls.render.length, 1, '渲染层应调用一次');

    assert.ok(settled.finalText.includes('回来了'), '正文应写入最终结果');
});

test('场景层不携带角色卡，人物层携带', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(0), merge: MERGE_JSON(0), render: LONG_PROSE },
    });
    seedSettings(harness, makeSettings());
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    await handle.complete;

    assert.equal(harness.calls.scene[0].includeCharacterCard, false, '场景层不应看角色卡（省 token 且避免被情绪带跑）');
    assert.equal(harness.calls.actor[0].includeCharacterCard, true, '人物层必须看角色卡');
    assert.equal(harness.calls.scene[0].worldInfoSource, 'chat', '场景层应激活世界书');
    assert.equal(harness.calls.merge[0].worldInfoSource, 'none', '整合层不需要重复激活世界书');
});

// ── 3. 强度路由（按回合）────────────────────────────────────────────────────

test('低强度走 light 渲染器', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(1), merge: MERGE_JSON(1), render: LONG_PROSE },
    });
    seedSettings(harness, makeSettings({ nsfwThreshold: 2 }));
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    await handle.complete;

    assert.equal(harness.calls.render[0].apiPresetName, 'render-light', 'intensity=1 应走 light');
});

test('高强度走 heavy 渲染器', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(3), merge: MERGE_JSON(3), render: LONG_PROSE },
    });
    seedSettings(harness, makeSettings({ nsfwThreshold: 2 }));
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    await handle.complete;

    assert.equal(harness.calls.render[0].apiPresetName, 'render-heavy', 'intensity=3 应走 heavy');
});

test('整合层不能把强度上调（人物层 1 / 整合层 3 → 最终 1）', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(1), merge: MERGE_JSON(3), render: LONG_PROSE },
    });
    seedSettings(harness, makeSettings({ nsfwThreshold: 2 }));
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    await handle.complete;

    assert.equal(harness.calls.render[0].apiPresetName, 'render-light',
        '整合层越权上调强度时必须被夹回人物层判定');
});

test('阈值可调：阈值降到 1 时 intensity=1 走 heavy', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(1), merge: MERGE_JSON(1), render: LONG_PROSE },
    });
    seedSettings(harness, makeSettings({ nsfwThreshold: 1 }));
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    await handle.complete;

    assert.equal(harness.calls.render[0].apiPresetName, 'render-heavy');
});

test('heavy 未配置且允许回退时降级到 light', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(3), merge: MERGE_JSON(3), render: LONG_PROSE },
    });
    seedSettings(harness, makeSettings({ renderHeavyApiProfile: '', heavyFallbackToLight: true }));
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    await handle.complete;

    assert.equal(harness.calls.render[0].apiPresetName, 'render-light', '应回退而不是空转');
});

test('heavy 未配置且禁止回退时使用当前聊天配置', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(3), merge: MERGE_JSON(3), render: LONG_PROSE },
    });
    seedSettings(harness, makeSettings({
        renderHeavyApiProfile: '',
        renderLightApiProfile: '',
        heavyFallbackToLight: false,
    }));
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    await handle.complete;

    assert.equal(harness.calls.render[0].apiPresetName, '', '应退到当前聊天 API 配置');
});

// ── 4. continue 前缀不变量 ──────────────────────────────────────────────────

test('continue：保留原前缀并追加新内容', async () => {
    const original = '她把伞靠在墙角，';
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(0), merge: MERGE_JSON(0), render: '水顺着伞骨淌下来。' },
        chat: [
            { is_user: true, mes: '继续' },
            { is_user: false, mes: original, name: '林晚' },
        ],
    });
    seedSettings(harness, makeSettings());
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({ type: 'continue', isContinue: true }).takeoverHandle;
    const settled = await handle.complete;

    assert.equal(settled.status, 'committed');
    assert.ok(settled.finalText.startsWith(original), '必须保留原前缀');
    assert.ok(settled.finalText.includes('水顺着伞骨淌下来'), '新内容应追加在前缀之后');
});

// ── 5. 失败与取消的终态选择 ─────────────────────────────────────────────────

test('上游阶段抛错时 discard 回滚', async () => {
    const harness = createMockContext({ failOn: 'actor' });
    seedSettings(harness, makeSettings());
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    const settled = await handle.complete;

    assert.equal(settled.status, 'discarded', '硬失败应回滚而非提交');
});

test('用户取消时 abort 保留已生成部分', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(0), merge: MERGE_JSON(0), render: LONG_PROSE },
        streamChunkDelayMs: 3,
    });
    seedSettings(harness, makeSettings());
    await loadPluginWithContext(harness.ctx);

    const controller = new AbortController();
    const handle = harness.dispatch({ abortSignal: controller.signal }).takeoverHandle;

    // 等渲染层开始流式输出后再取消，验证「保留已生成部分」的语义
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(handle.getText().length > 0, '取消前应已有部分输出');
    controller.abort();

    const settled = await handle.complete;
    assert.equal(settled.status, 'aborted', '用户取消应 abort');
    assert.notEqual(settled.status, 'committed', '绝不能把被取消的内容当作最终输出固化');
    assert.ok(settled.finalText.length > 0, 'abort 应保留已流出的部分');
});

// ── 6. 退化检测与重试 ───────────────────────────────────────────────────────

test('渲染结果过短时自动重试一次', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(0), merge: MERGE_JSON(0) },
        renderSequence: [SHORT_PROSE, LONG_PROSE],
    });
    seedSettings(harness, makeSettings({ retryOnDegenerate: true }));
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    const settled = await handle.complete;

    assert.equal(harness.renderCallCount(), 2, '应重试一次');
    assert.equal(settled.status, 'committed');
    assert.ok(settled.finalText.includes('回来了'), '最终应使用重试后的内容');

    const retryContent = harness.calls.render[1].taskMessages[1].content;
    assert.ok(retryContent.includes('上一次生成被判定为无效'), '重试请求应带上纠偏说明');
});

test('重试后仍退化则照常提交（不无限重试）', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(0), merge: MERGE_JSON(0) },
        renderSequence: [SHORT_PROSE, SHORT_PROSE],
    });
    seedSettings(harness, makeSettings({ retryOnDegenerate: true }));
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    const settled = await handle.complete;

    assert.equal(harness.renderCallCount(), 2, '只重试一次');
    assert.equal(settled.status, 'committed', '不能因为退化就无限重试或丢弃用户回合');
});

test('关闭重试时不额外调用', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(0), merge: MERGE_JSON(0) },
        renderSequence: [SHORT_PROSE],
    });
    seedSettings(harness, makeSettings({ retryOnDegenerate: false }));
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    await handle.complete;

    assert.equal(harness.renderCallCount(), 1);
});

// ── 7. 非流式降级路径 ───────────────────────────────────────────────────────

test('无 generateTaskStream 时降级为整段提交', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(0), merge: MERGE_JSON(0), render: LONG_PROSE },
        noStream: true,
    });
    seedSettings(harness, makeSettings());
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    const settled = await handle.complete;

    assert.equal(settled.status, 'committed');
    assert.ok(settled.finalText.includes('回来了'), '降级路径同样要产出正文');
});

// ── 8. 上下文与文风锚 ───────────────────────────────────────────────────────

test('文风锚取上一回合结尾，且 regenerate 时排除当前 slot', async () => {
    const previous = '这是上一个回合的结尾。';
    const currentSlot = '这是当前要被重写的那一条。';
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(0), merge: MERGE_JSON(0), render: LONG_PROSE },
        chat: [
            { is_user: true, mes: '第一次' },
            { is_user: false, mes: previous, name: '林晚' },
            { is_user: true, mes: '第二次' },
            { is_user: false, mes: currentSlot, name: '林晚' },
        ],
    });
    seedSettings(harness, makeSettings({ styleAnchorEnabled: true, styleAnchorChars: 600 }));
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({ type: 'regenerate' }).takeoverHandle;
    await handle.complete;

    const renderContent = harness.calls.render[0].taskMessages[1].content;
    assert.ok(renderContent.includes(previous), '应把上一回合结尾作为衔接锚点');
    assert.ok(!renderContent.includes(currentSlot), '不应把正在被重写的当前 slot 当作参考');
});

test('关闭文风锚时不注入', async () => {
    const harness = createMockContext({
        responses: { scene: SCENE_JSON, actor: ACTOR_JSON(0), merge: MERGE_JSON(0), render: LONG_PROSE },
    });
    seedSettings(harness, makeSettings({ styleAnchorEnabled: false }));
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    await handle.complete;

    const mergeContent = harness.calls.merge[0].taskMessages[1].content;
    assert.ok(mergeContent.includes('没有可用的上文'), '关闭时应使用占位而不是真实上文');
});

// ── 9. 上游 JSON 解析失败时的降级 ───────────────────────────────────────────

test('上游返回非 JSON 时降级为文本传递而不是崩溃', async () => {
    const harness = createMockContext({
        responses: {
            scene: '这里是场景说明，但不是 JSON。门锁着，雨很大，屋子里只有厨房的余光。',
            actor: '角色会抬头看你一眼，然后继续换鞋，什么也不说。',
            merge: '按顺序写：环境、动作、台词。视角沿用第三人称。',
            render: LONG_PROSE,
        },
    });
    seedSettings(harness, makeSettings());
    await loadPluginWithContext(harness.ctx);

    const handle = harness.dispatch({}).takeoverHandle;
    const settled = await handle.complete;

    assert.equal(settled.status, 'committed', '上游格式不合规也应能完成回合');
    assert.ok(settled.finalText.includes('回来了'));
});

// ── 10. 不处理的生成类型 ────────────────────────────────────────────────────

test('impersonate / quiet 等类型不接管', async () => {
    const harness = createMockContext();
    seedSettings(harness, makeSettings());
    const mod = await loadPluginWithContext(harness.ctx);

    // 直接走内部路径：dispatch 一个非法类型
    const payload = harness.dispatch({ type: 'impersonate' });
    assert.equal(payload.takeoverHandle, null, '不支持的生成类型不应接管');
    void mod;
});
