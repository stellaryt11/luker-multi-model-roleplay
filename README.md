# Multi-Model Roleplay (Luker)

> 把一个回合拆给多个模型协作完成：**场景 / 人物 / 整合 / 渲染**。
>
> Split one roleplay turn across multiple models — scene builder, character actor, integrator, and renderer.

**Language:** [English](#english) · [中文](#中文)

---

## 中文

### 这是什么

一个 Luker 插件。默认情况下，一次回复由同一个模型从「世界描写」一路写到「角色台词」。这个插件把这一回合拆成四个职能，每个职能可以绑到**不同的模型**：

| 层 | 拥有什么 | 唯一决策权 | 建议用什么模型 |
| --- | --- | --- | --- |
| ① **场景层** | 世界的**事实** | 什么发生了 | 便宜、逻辑强、长上下文 |
| ② **人物层** | 角色的**意志** | 角色如何回应 + NSFW 强度判定 | 最擅长扮演的模型 |
| ③ **整合层** | 文本的**形态** | 怎么写成那段字（仲裁冲突） | 结构化输出稳定的模型 |
| ④ **渲染层** | **唯一的正文作者** | 文笔 | 通用文笔好 / 专精成人向 |

前三层永不输出露骨正文，露骨内容只在第 ④ 层出现。

### 为什么这样设计

关键原则：**按「决策权」切分模型，不按「内容类型」切分。**

内容标签（比如"NSFW"）和职能是交叉关系——亲密场景恰恰是"人物意志"最密集的地方（喘息、台词、心理、身体反应全是人物层的活儿）。按内容类型切模型，会让两个模型在同一段落里争夺话语权，接缝处两边都不像。

按决策权切就没有这个问题：

- 场景层**只**说世界的事实，不写角色反应；
- 人物层**只**裁决角色意志，不发明环境；
- 整合层**只**仲裁冲突与定形态，不写正文；
- 渲染层**只**写，不决策。

### 架构

```
用户输入
   │
   ├─ ① 场景层（模型 A）    → 场景事实卡：时间地点 / 环境 / NPC 动向 / 硬约束 / 锚点
   │                            不看角色卡（省 token，也避免被角色情绪带跑）
   │
   ├─ ② 人物层（模型 B）    → 角色意志：节拍 / 动作 / 台词意图 / 情绪 / nsfw_intensity
   │                            持有强度判定权 —— 它最清楚剧情走到哪一步
   │
   ├─ ③ 整合层（模型 C）    → 渲染指令：视角 / 文风 / 有序渲染块 / 禁止项
   │                            仲裁人物意图与场景硬约束的冲突
   │                            强度只能沿用或下调，绝不可上调
   │
   └─ ④ 渲染层（模型 D）    → 最终正文（流式输出，边生成边显示）
                                强度 ≥ 阈值 → 高强度渲染器
                                强度 < 阈值 → 低强度渲染器
```

### 强度路由：按回合，不按段落

`nsfw_intensity` 由**人物层**判定（0-3），整合层只能沿用或下调。

**本回合的最高强度决定整条消息用哪个渲染器。** 这是刻意的取舍：一条消息内切换模型会造成一条消息内两种笔触，这是读者最能察觉的破绽。宁可整条交给高强度渲染器，也不要让笔触在消息中间突变。

代价是：一回合从日常滑向亲密时，整条都由高强度渲染器执笔，它的日常文笔短板会暴露。**但至少文风是统一的。**

### 安装

需要 **Luker**（不是原生 SillyTavern，见下方兼容性）。

1. 打开 Luker
2. 扩展 → **安装扩展**
3. 粘贴本仓库地址：
   ```
   https://github.com/stellaryt11/luker-multi-model-roleplay
   ```
4. 安装完成后在扩展面板里启用 **Multi-Model Roleplay**

### 配置

两台连接方式，**二选一**：

**方式 A：用 Luker 的 Connection Profile（推荐）**

在 Luker 的连接配置里建 4–5 个配置档，每个指向你要用的模型：

| 配置档 | 用途 |
| --- | --- |
| 场景模型 | 例如一个便宜的长上下文模型 |
| 人物模型 | 例如你最满意的扮演模型 |
| 整合模型 | 结构化输出稳定的模型 |
| 低强度渲染 | 日常对话文笔好的模型 |
| 高强度渲染 | 专门处理亲密内容的模型（可与上面不同） |

> **Profile 里不存 API key。** 密钥按 API 类型全局存在服务端 secrets 里，
> 所以建多个 Profile 不会让你重复填密钥。"复用同一个端点和密钥、只换模型"
> 就是这么做的。

**方式 B：用插件内的自定义连接**

需要"自建端点 + 专属密钥 + 单独选模型"时用它。在设置面板的「自定义 API 连接」里：
填写端点 → 保存密钥 → 点「拉取模型」→ 选模型。
密钥会写进 Luker 服务端 secrets，以 `secret_id` 引用，**不进插件设置、不落盘、不回显**。

**最后：在插件面板里给每一层选连接**（下拉里会同时列出 Luker Profile 和自定义连接），
然后打开总开关。

> 建议先保持 `enabled` 关闭，配置完再打开。

### 关于预设：准备层和渲染层吃的东西不一样

这一点很容易踩坑，建议了解：

- **准备层（场景 / 人物 / 整合）默认使用插件内置的「纯净预设」**。它只保留结构性注入
  （角色卡 / 世界书 / 聊天历史），不含任何固定提示词。
- **渲染层留空 = 使用你当前激活的 RP 预设** —— 也就是你精心调好的那一套。

为什么这么设计？`generateTask` 组装提示词时的行为是：

> 保留活跃预设中聊天历史以外的内容，仅替换聊天历史部分为你提供的 messages

也就是说 **留空预设 ≠ 不用预设，而是用你当前选中的那个**。对 RP 用户来说，
那是整套越狱 + 文风 + NSFW 指导（实测可达两万多字符固定提示词）。让准备层吃下它会导致：
场景层被文风带得写起散文、整合层的 JSON 指令与文风指令打架、每回合多注入数万字符。

如果你确实想让某一层用某个特定预设，直接在该层填写预设名即可（会覆盖纯净预设）；
也可以在设置里关掉「准备层使用内置纯净预设」开关。

### 故障排查

插件会把底层错误翻译成「哪一层 + 什么问题 + 该怎么办」，常见几类：

| 提示 | 含义 | 怎么处理 |
| --- | --- | --- |
| 「XX层」鉴权失败（401） | 该层的密钥或端点不对 | 检查对应连接配置的密钥与端点 |
| 端点返回了非标准响应（no choices） | 该端点不是 OpenAI 兼容接口 —— 例如 Cline、Cursor 这类**客户端专用 API**，需要它们自己的认证方式 | 换成标准兼容端点 |
| 端点不支持结构化输出 | 端点不认 `response_format` | 设置里关掉「请求结构化输出」 |
| 触发限流（429） | 额度用尽或频率过高 | 稍后重试，或换密钥 |
| 网络不可达 | 端点地址连不上 | 检查地址 / 代理 / 服务是否在跑 |
| 后台出现一堆 `/api/sd/*  500` | **与本插件无关** | 是 stable-diffusion 扩展连不上 SD 后端 |

> 多模型架构下，四层用的是四个不同的连接，所以「**哪一层**出错」是最关键的信息 —— 插件会把它放在提示最前面。

### 健壮性设计

- **进度占位**：准备阶段会显示「正在构建场景事实…」，不会让用户对着空屏等。
- **退化检测**：渲染结果过短、出现 AI 自称、出现拒绝话术时自动重试一次。网关对成人内容的**静默阉割**是看不见的失败，不检测就发现不了。
- **流式降级**：API 家族不支持流式时自动退回整段提交。
- **文风锚**：把上一回合正文的结尾喂给渲染器，减少笔触突变。
- **终态正确性**：自然完成走 `commit`、用户取消走 `abort`（保留已生成部分但不落盘）、硬失败走 `discard`（回滚）。选错会和下一回合产生竞态。

### 常见问题

**Q：和内置的「多 Agent 编排」能一起用吗？**
默认策略是**让出**：如果编排器（Director 模式）先接管了本回合，本插件会跳过。想反过来抢占，把设置里的「与其它接管者冲突时」改成「抢占本回合」——但那样编排器可能没有输出。

**Q：为什么这么慢？**
四层串行 = 四次调用。这是用延迟换叙事质量。可以提高强度阈值、或把前几层配到更快的模型来缓解。

**Q：可以只启用一部分层吗？**
把用不到的层留空即可，它们会跟随当前聊天配置。但注意：如果场景层与人物层用同一个模型，那就退化成普通的单模型了，插件的价值主要在"上下文分工"和"强度路由"。

**Q：支持 SillyTavern 吗？**
不支持。本插件依赖 Luker 独有的消息接管机制（`GENERATE_TAKEOVER_DISPATCH`），原生 SillyTavern 没有这套 API。装到 ST 上不会崩溃——插件会检测能力并安全禁用，但功能不可用。

### 隐私

**本插件会把你的聊天内容分别发送给你配置的多个 API 服务商。** 数据外发量比单模型模式更多（每回合 4 次请求）。请自行确认各服务商的隐私条款与数据处理方式。

### 开发

纯 ESM，无构建步骤。

```bash
npm test          # 运行端到端流水线测试（mock Luker 环境，22 个用例）
```

开发时可以用 junction / 软链接把本目录挂到 `public/scripts/extensions/third-party/` 下，改动即时生效。

### 许可

MIT。本插件不 import 任何 Luker 核心模块或编排器源码，全部通过全局 `Luker.getContext()` 与公开 API 交互。

---

## English

### What is this

A Luker plugin. Normally a single model writes everything in one reply — from world description to character dialogue. This plugin splits each turn into four roles, and each role can be bound to a **different model**:

| Layer | Owns | Sole decision right | Suggested model |
| --- | --- | --- | --- |
| ① **Scene** | the world's **facts** | what happens | cheap, strong logic, long context |
| ② **Actor** | the character's **will** | how the character responds + NSFW intensity | your best roleplay model |
| ③ **Merge** | the text's **form** | how it becomes prose (arbitration) | reliable structured output |
| ④ **Render** | **the only prose author** | the writing itself | general prose / adult-specialized |

Layers ①–③ never emit explicit prose. Explicit content only appears at layer ④.

### Why split this way

The core principle: **partition models by decision right, not by content label.**

Content labels (e.g. "NSFW") cross-cut roles — intimate scenes are exactly where the character's will is densest (breathing, dialogue, psychology, physical reactions are all actor-layer work). Splitting by content label makes two models fight over the same paragraph, and the seam reads like neither of them.

Splitting by decision right avoids this entirely:

- Scene **only** states the world's facts — never character reactions.
- Actor **only** adjudicates the character's will — never invents environment.
- Merge **only** arbitrates conflicts and fixes the form — never writes prose.
- Render **only** writes — never decides.

### Architecture

```
user input
   │
   ├─ ① Scene  (model A)  → fact card: time/place, environment, NPC motion, hard constraints, anchors
   │                        no character card (saves tokens, avoids being pulled by character emotion)
   │
   ├─ ② Actor  (model B)  → will card: beats, action, dialogue intent, emotion, nsfw_intensity
   │                        holds the intensity verdict — it knows best how far the story has gone
   │
   ├─ ③ Merge  (model C)  → render plan: POV, voice, ordered render blocks, forbidden list
   │                        arbitrates actor intent against scene hard constraints
   │                        intensity may only be kept or lowered, never raised
   │
   └─ ④ Render (model D)  → final prose (streamed as it is generated)
                            intensity >= threshold → heavy renderer
                            intensity <  threshold → light renderer
```

### Intensity routing: per turn, not per paragraph

`nsfw_intensity` is decided by the **actor** layer (0–3). The merge layer may only keep or lower it.

**The turn's peak intensity decides which renderer writes the whole message.** This is a deliberate trade-off: switching models mid-message produces two different writing voices inside one message, which is the most noticeable flaw of all. Better to hand the entire message to the heavy renderer than to let the voice shift mid-paragraph.

### Install

Requires **Luker** (not vanilla SillyTavern — see compatibility below).

1. Open Luker
2. Extensions → **Install extension**
3. Paste this repository URL:
   ```
   https://github.com/stellaryt11/luker-multi-model-roleplay
   ```
4. Enable **Multi-Model Roleplay** in the extensions panel

### Configure

1. Create 4–5 **Connection Profiles**, one per model you intend to use.
2. In the plugin panel, pick a profile for each layer. Use "Refresh profile list" to re-query.
3. Flip the master switch on.

### Robustness

- **Progress placeholders** during the preparation layers.
- **Degeneracy detection**: output too short, AI self-reference, or refusal phrasing triggers one retry. Silent gateway truncation of adult content is invisible without this.
- **Stream downgrade** when the API family lacks streaming.
- **Style anchor**: the tail of the previous turn is fed to the renderer to reduce voice jumps.
- **Correct terminal states**: `commit` on success, `abort` on user cancel (keeps partial, does not persist), `discard` on hard failure (rolls back). Picking the wrong one races with the next turn.

### Compatibility

Luker only. This plugin relies on Luker's message takeover mechanism (`GENERATE_TAKEOVER_DISPATCH`), which vanilla SillyTavern does not provide. Installed on ST it will detect the missing capability and disable itself safely rather than break your environment.

### Privacy

**This plugin sends your chat content to multiple third-party API providers.** Outbound data volume is higher than in single-model mode (4 requests per turn). Check each provider's privacy terms yourself.

### License

MIT. The plugin imports no Luker core modules or orchestrator sources; it interacts purely through the global `Luker.getContext()` and public APIs.
