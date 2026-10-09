// SPDX-License-Identifier: MIT
/**
 * 插件内置的「纯净预设」（synthetic Chat Completion preset）。
 *
 * 为什么需要它
 * ------------
 * `generateTask` 组装提示词时会走 Luker 的信封机制
 * （`buildPresetAwarePromptMessages`），其行为是：
 *
 *   「保留活跃预设中聊天历史以外的内容，仅替换聊天历史部分为你提供的 messages」
 *
 * 也就是说 —— **留空 llmPresetName 并不等于"不使用预设"，而是"使用用户当前
 * 选中的预设"**。对角色扮演用户来说，那是他们精心调好的完整 RP 预设，可能包含
 * 两万多字符的固定提示词（越狱、文风、字数要求、NSFW 指导、状态栏规则…）。
 *
 * 让场景层/人物层/整合层吃下这些内容是**有害的**：
 *   - 场景层本该只输出世界事实，被文风提示词一带就开始写散文；
 *   - 整合层一边被要求输出 JSON，一边收到"文风""防止机器人"之类的指令，互相打架；
 *   - 前三层还要重复承担数万字符的注入成本。
 *
 * 所以前三层改用下面这份纯净预设：它**只保留结构性 marker**
 * （世界书、角色卡、聊天历史），把用户预设里的固定提示词条目全部去掉。
 * 真正需要的东西（角色卡、世界书、JSON 结构）都是通过参数注入的，不靠预设。
 * 渲染层则继续使用用户自己的完整预设 —— 那里才是它该生效的地方。
 *
 * 实现方式
 * --------
 * 参照编排器 Director 模式的做法：把一个 body 推进 `ctx.openai.settings`
 * 数组，并把名字登记到 `ctx.openai.settingNames`（name → index）。之后
 * `getOpenAIPresetByName` 就能按名字找到它，`generateTask({ llmPresetName })`
 * 即可使用。整个过程只改内存，不写磁盘。
 *
 * 本文件内容为自行撰写（字段名为 Luker/ST 的公开配置契约），
 * 未复制任何 AGPL 许可的源码内容。
 */

import { logDebug, logWarn } from './utils.js';

/** 带命名空间，避免与用户预设或其它插件重名。 */
export const PURE_PRESET_NAME = 'multi-model-roleplay:pure';

/**
 * 主提示词。
 *
 * 刻意写得极简：前三层各自的任务定义由插件在 taskMessages 的 system 消息里
 * 给出，这里只需要压住"不要角色扮演"这一个默认倾向，避免模型把事实提取任务
 * 当成表演。
 */
const MAIN_PROMPT = [
    '你是一个专注于执行任务的助手。',
    '严格按照对话中给出的指令行事。',
    '除非被明确要求，否则不要进行角色扮演、不要代入任何人格、不要输出与任务无关的文学性描写。',
].join('');

function buildPrompts() {
    return [
        {
            name: 'Main Prompt',
            system_prompt: true,
            role: 'system',
            content: MAIN_PROMPT,
            identifier: 'main',
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100,
            injection_trigger: [],
            forbid_overrides: false,
        },
        // 以下均为结构性 marker：内容为空，由信封机制按需填充。
        { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
        { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
        { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
        { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
        { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
        { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
        {
            name: 'Post-History Instructions',
            system_prompt: true,
            role: 'system',
            content: '',
            identifier: 'jailbreak',
        },
        { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
        { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
    ];
}

/**
 * 顺序里只保留必要的条目。
 * `chatHistory` 是插件 taskMessages 的插入位置，缺了它整个请求都会错位。
 */
function buildPromptOrder() {
    return [
        {
            character_id: 100000,
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'worldInfoBefore', enabled: true },
                { identifier: 'charDescription', enabled: true },
                { identifier: 'charPersonality', enabled: true },
                { identifier: 'scenario', enabled: true },
                { identifier: 'worldInfoAfter', enabled: true },
                { identifier: 'dialogueExamples', enabled: false },
                { identifier: 'chatHistory', enabled: true },
                { identifier: 'jailbreak', enabled: true },
            ],
        },
    ];
}

/**
 * 纯净预设 body。
 *
 * 采样参数偏保守：这三层做的是提取、裁决、仲裁，需要稳定而不是发挥。
 * `stream_openai: false` 因为前三层不流式（只有渲染层需要实时显示）。
 */
export function buildPurePresetBody() {
    return {
        temperature: 0.6,
        frequency_penalty: 0,
        presence_penalty: 0,
        top_p: 1,
        top_k: 0,
        top_a: 0,
        min_p: 0,
        repetition_penalty: 1,
        max_context_unlocked: true,
        openai_max_context: 2000000,
        openai_max_tokens: 8000,
        names_behavior: 0,
        send_if_empty: '',
        new_chat_prompt: '[Start a new Chat]',
        new_group_chat_prompt: '[Start a new group chat. Group members: {{group}}]',
        new_example_chat_prompt: '[Example Chat]',
        continue_nudge_prompt: '[Continue your last message without repeating its original content.]',
        bias_preset_selected: 'Default (none)',
        wi_format: '{0}',
        scenario_format: '{{scenario}}',
        personality_format: '{{personality}}',
        group_nudge_prompt: '[Write the next reply only as {{char}}.]',
        stream_openai: false,
        prompts: buildPrompts(),
        prompt_order: buildPromptOrder(),
        assistant_prefill: '',
        assistant_impersonation: '',
        use_sysprompt: false,
        squash_system_messages: false,
        continue_prefill: false,
        continue_postfix: ' ',
        function_calling: false,
        show_thoughts: true,
        reasoning_effort: 'auto',
        verbosity: 'auto',
        seed: -1,
        n: 1,
    };
}

/** 注册状态（进程内）。 */
let registered = false;

export function isPurePresetReady() {
    return registered;
}

/** 仅供测试重置。 */
export function __resetPurePresetState() {
    registered = false;
}

/**
 * 把纯净预设注册进 Luker 的预设表。
 *
 * 幂等：名字已存在时原地替换 body（与编排器做法一致，保证下拉顺序不变）。
 * 任何一步失败都只是返回 false，不抛错 —— 插件会在没有纯净预设的情况下
 * 退回"跟随当前预设"的行为，功能仍然可用。
 *
 * @param {object} ctx Luker context
 * @returns {boolean} 是否可用
 */
export function ensurePurePresetRegistered(ctx) {
    if (registered) {
        return true;
    }

    const settings = ctx?.openai?.settings;
    const settingNames = ctx?.openai?.settingNames;

    if (!Array.isArray(settings) || !settingNames || typeof settingNames !== 'object') {
        logWarn(
            '无法注册纯净预设（ctx.openai.settings / settingNames 不可用），' +
            '前三层将回退为跟随当前预设 —— 这会把 RP 预设注入到准备层，建议检查 Luker 版本。',
        );
        return false;
    }

    try {
        const body = buildPurePresetBody();
        const existingIndex = settingNames[PURE_PRESET_NAME];

        if (Number.isInteger(existingIndex) && existingIndex >= 0 && existingIndex < settings.length) {
            settings[existingIndex] = body;
            registered = true;
            logDebug('纯净预设已就地更新');
            return true;
        }

        settings.push(body);
        settingNames[PURE_PRESET_NAME] = settings.length - 1;
        registered = true;
        logDebug(`纯净预设已注册：${PURE_PRESET_NAME}（index ${settings.length - 1}）`);
        return true;
    } catch (err) {
        logWarn('注册纯净预设失败，回退为跟随当前预设', err);
        return false;
    }
}

/**
 * 解析准备层（场景/人物/整合）该用哪个预设。
 *
 * 优先级：用户显式指定的预设名 > 纯净预设 > 空（跟随当前预设）
 *
 * @param {object} settings 插件设置
 * @param {string} explicitName 该层用户填写的预设名
 */
export function resolvePrepPresetName(settings, explicitName) {
    const named = String(explicitName || '').trim();
    if (named) {
        return named;
    }
    if (settings?.prepLayersUsePurePreset !== false && registered) {
        return PURE_PRESET_NAME;
    }
    return '';
}
