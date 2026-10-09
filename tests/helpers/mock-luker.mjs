// SPDX-License-Identifier: MIT
/**
 * 最小 Luker 环境模拟，用于在不启动 Luker 的情况下验证插件行为。
 *
 * 只实现插件实际触及的接口，行为对齐 public/scripts/message-takeover.js
 * 与 docs 中的契约（三种终态互斥、continue 前缀不变量等）。
 */

export const EVT_TAKEOVER = 'GENERATE_TAKEOVER_DISPATCH';

/** 构造一个 handle，行为与真实 message-takeover 句柄一致。 */
function createHandle(opts) {
    const state = {
        text: String(opts.originalText ?? ''),
        reasoning: String(opts.originalReasoning ?? ''),
        status: null,
        setTextCalls: 0,
    };
    const originalText = String(opts.originalText ?? '');
    const continueMode = opts.generationType === 'continue';

    let resolveComplete;
    const complete = new Promise((resolve) => {
        resolveComplete = resolve;
    });

    const settle = (status) => {
        state.status = status;
        resolveComplete({
            status,
            finalText: state.text,
            finalReasoning: state.reasoning,
        });
    };

    return {
        getText: () => state.text,
        getReasoning: () => state.reasoning,
        setText(value) {
            if (state.status) throw new Error(`editor_${state.status}`);
            const next = String(value);
            if (continueMode && !next.startsWith(originalText)) {
                throw new Error('invalid_op_for_continue');
            }
            state.text = next;
            state.setTextCalls += 1;
        },
        setReasoning(value) {
            if (state.status) throw new Error(`editor_${state.status}`);
            state.reasoning = String(value);
        },
        async commit() {
            if (state.status && state.status !== 'committed') throw new Error(`editor_${state.status}`);
            if (state.status === 'committed') return;
            settle('committed');
        },
        async abort() {
            if (state.status && state.status !== 'aborted') throw new Error(`editor_${state.status}`);
            if (state.status === 'aborted') return;
            settle('aborted');
        },
        async discard() {
            if (state.status && state.status !== 'discarded') throw new Error(`editor_${state.status}`);
            if (state.status === 'discarded') return;
            state.text = originalText;
            state.reasoning = String(opts.originalReasoning ?? '');
            settle('discarded');
        },
        complete,
        abortSignal: opts.abortSignal,
        setOnUpdate() {},
        owner: opts.owner,
        _state: state,
    };
}

/**
 * 构造模拟 context。
 *
 * @param {object} config
 * @param {object} config.responses 各层返回的内容，键为 'scene'|'actor'|'merge'|'render'
 * @param {string[]} [config.renderChunks] 渲染层流式分片
 * @param {number}   [config.renderStreamCalls] 渲染层被调用的次数（由测试读取）
 */
export function createMockContext(config = {}) {
    const responses = config.responses ?? {};
    const handles = [];
    const calls = { scene: [], actor: [], merge: [], render: [] };
    const events = new Map();

    const renderChunks = config.renderChunks ?? null;
    // 允许按调用序号给出不同的渲染输出（用于验证重试）
    const renderSequence = config.renderSequence ?? null;
    let renderCallIndex = 0;
    const schemaErrorCount = {};

    function identify(systemPrompt) {
        const text = String(systemPrompt ?? '');
        if (text.includes('场景构建者')) return 'scene';
        if (text.includes('角色意志裁决者')) return 'actor';
        if (text.includes('叙事整合者')) return 'merge';
        if (text.includes('最终执笔者')) return 'render';
        return 'unknown';
    }

    function resolvePayload(kind) {
        if (kind === 'render' && renderSequence) {
            const value = renderSequence[Math.min(renderCallIndex, renderSequence.length - 1)];
            return value;
        }
        return responses[kind] ?? '';
    }

    async function generateTask(opts) {
        const kind = identify(opts.taskMessages?.[0]?.content);
        calls[kind]?.push(opts);

        if (opts.abortSignal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
        }
        if (config.failOn === kind) {
            throw new Error(`mock failure in ${kind}`);
        }
        // 模拟「端点不支持结构化输出」：该层首次调用报 schema 错误
        if (config.schemaErrorOn === kind && (schemaErrorCount[kind] = (schemaErrorCount[kind] ?? 0) + 1) === 1) {
            throw new Error(
                'Got response status 400 from : {"error":{"message":"response_format.json_schema.schema is required"}}',
            );
        }

        const payload = resolvePayload(kind);
        if (kind === 'render') {
            renderCallIndex += 1;
        }

        const text = typeof payload === 'function' ? payload(opts) : payload;
        return { assistantText: String(text ?? ''), toolCalls: [], reasoning: null, usage: null };
    }

    function generateTaskStream(opts) {
        const kind = identify(opts.taskMessages?.[0]?.content);
        calls[kind]?.push(opts);

        const payload = resolvePayload(kind);
        if (kind === 'render') {
            renderCallIndex += 1;
        }
        const text = String(typeof payload === 'function' ? payload(opts) : (payload ?? ''));
        const chunks = renderChunks ?? splitIntoChunks(text);

        const stream = (async function* streamGenerator() {
            if (opts.abortSignal?.aborted) {
                const err = new Error('aborted');
                err.name = 'AbortError';
                throw err;
            }
            if (config.failOn === kind) {
                throw new Error(`mock failure in ${kind}`);
            }
            const delay = Number(config.streamChunkDelayMs ?? 0);
            for (const chunk of chunks) {
                if (delay > 0) {
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
                if (opts.abortSignal?.aborted) {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    throw err;
                }
                yield { type: 'text', delta: chunk };
            }
        })();

        const result = Promise.resolve({ assistantText: text, toolCalls: [], reasoning: null });
        return { stream, result };
    }

    const ctx = {
        extensionSettings: {},
        // 合成预设需要的预设表（纯内存）
        openai: {
            settings: [],
            settingNames: {},
        },
        chat: config.chat ?? [
            { is_user: true, mes: '你回来了？' },
            { is_user: false, mes: '嗯。她站在门口，把湿透的伞靠在墙边。', name: '林晚' },
        ],
        name1: 'User',
        name2: '林晚',
        characters: [{ name: '林晚' }],
        characterId: 0,
        connectionProfiles: { list: () => config.profiles ?? [] },
        generateTask,
        generateTaskStream: config.noStream ? undefined : generateTaskStream,
        createMessageEditorHandle: (opts) => {
            const handle = createHandle(opts);
            handles.push(handle);
            return handle;
        },
        eventTypes: { GENERATE_TAKEOVER_DISPATCH: EVT_TAKEOVER },
        eventSource: {
            on(type, handler) {
                if (!events.has(type)) events.set(type, []);
                events.get(type).push(handler);
            },
        },
        saveSettingsDebounced: () => {},
    };

    return {
        ctx,
        handles,
        calls,
        /** 预设表（供断言合成预设是否注册成功） */
        openaiSettings: ctx.openai.settings,
        openaiSettingNames: ctx.openai.settingNames,
        renderCallCount: () => renderCallIndex,
        /** 触发一次接管分发，返回事件载荷（便于断言 takeoverHandle 是否被填充） */
        dispatch(eventData) {
            const handlers = events.get(EVT_TAKEOVER) ?? [];
            const payload = {
                type: 'normal',
                isContinue: false,
                forceName2: false,
                isStreamingEnabled: true,
                finalPrompt: null,
                generateData: null,
                takeoverHandle: null,
                abortSignal: new AbortController().signal,
                ...eventData,
            };
            for (const handler of handlers) {
                handler(payload);
            }
            return payload;
        },
    };
}

function splitIntoChunks(text, size = 12) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
    }
    return chunks;
}

/** 安装全局 Luker 并导入插件入口（每次调用都拿全新模块实例）。 */
export async function loadPluginWithContext(ctx, { cacheBust = '' } = {}) {
    globalThis.Luker = { getContext: () => ctx };

    // 纯净预设的注册状态是模块级的，测试间需要重置，否则第二个用例会因
    // 短路而沿用上一个 ctx 的注册结果。
    const purePreset = await import('../../src/pure-preset.js');
    purePreset.__resetPurePresetState();

    const version = cacheBust || String(Math.random());
    const mod = await import(`../../index.js?v=${version}`);
    mod.init();
    return mod;
}
