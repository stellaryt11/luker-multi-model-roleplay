# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## [0.1.0] — 未发布

### 新增

- 四层多模型流水线：场景 → 人物 → 整合 → 渲染。
- 每层可独立绑定 Connection Profile 与 chat completion 预设。
- **按回合**的 NSFW 强度路由（人物层判定 → 整合层只可沿用/下调 → 分档渲染器）。
- 低强度 / 高强度双渲染器，支持未配置时回退。
- 消息接管（`GENERATE_TAKEOVER_DISPATCH`），主 LLM 不被调用。
- 三种终态正确处理：`commit` / `abort`（用户取消保留 partial）/ `discard`（硬失败回滚）。
- `continue` 前缀不变量支持。
- 退化检测与单次自动重试（针对网关静默阉割）。
- 流式输出 + 无流式 API 家族的自动降级。
- 文风锚：上一回合结尾注入渲染器，减少笔触突变。
- 准备阶段进度占位。
- 与其它接管者的冲突策略（让出 / 抢占）。
- 完整中文设置面板，支持提示词覆盖。
- 22 个端到端流水线测试（mock Luker 环境）。

## [0.1.1] — 未发布

### 修复

- **设置面板可能不显示**：原实现完全依赖 `manifest.hooks.activate` 触发初始化，
  一旦平台未读取该字段或钩子未触发，插件会完全静默。现改为**双保险**：
  模块顶层即调度 DOM ready 后的自启动，`hooks.activate` 保留为兼容路径，
  两者通过幂等标记避免重复初始化。

### 新增

- **`mmrpDiagnose()`** 全局诊断入口：一条命令输出加载状态、能力检测结果、
  面板挂载情况与当前设置，无需靠猜。
- 启动横幅日志（不受调试开关控制），用于确认插件是否真正加载。
- 设置面板挂载失败/成功时会给出明确提示与 toastr 通知，避免「装了但找不到」。
- 挂载容器查找扩展到 `.extensions_block` 与 `#rm_extensions_block` 兜底。
- 新增 3 个测试：能力不足时安全禁用、init 幂等、诊断报告准确性。

## [0.1.2] — 未发布

### 修复

- **设置面板 404（根因）**：`PLUGIN_ROOT_URL` 定义在 `src/utils.js` 里却直接使用
  `import.meta.url` 的目录部分，得到的是 `<plugin>/src/` 而不是插件根目录，
  导致请求变成 `.../multi-model-roleplay/src/settings.html` 而 404。
  改为 `new URL('..', import.meta.url)` 上跳一级。常量同时更名为
  `PLUGIN_ROOT_URL`（原名 `MODULE_FOLDER_URL` 有歧义，正是它掩盖了这个错误）。

### 新增

- 3 个资源路径回归测试：断言根目录 URL 不含 `/src/`、拼出的 `settings.html`
  在磁盘上真实存在、`manifest.json` 引用的 js/css 均存在于根目录。
  已验证过测试有效性（注入错误实现时 3 个用例全部失败）。

## [0.2.0] — 未发布

### 修复（重要）

- **准备层不再被用户 RP 预设污染**。此前 `llmPresetName` 留空的真实语义是
  「使用当前激活的预设」而非「不使用预设」，导致场景/人物/整合三层都会完整
  吃下用户的 RP 预设。实测该预设可达 **23,580 字符固定提示词**（越狱、文风、
  字数要求、NSFW 指导、状态栏规则…），后果具体且严重：
  - 场景层被文风提示词带跑，开始写散文，破坏「只输出世界事实」的职责边界；
  - 整合层一边被要求输出 JSON，一边收到文风/防机器人指令，两者互相打架；
  - 每回合约 7 万字符的重复注入。

### 新增

- **内置纯净预设**（`multi-model-roleplay:pure`）：准备层默认改用它，只保留
  结构性 marker（角色卡 / 世界书 / 聊天历史），去掉全部固定提示词条目。
  渲染层不受影响，继续使用用户的完整预设 —— 那里才是它该生效的地方。
  通过 `prepLayersUsePurePreset` 开关控制（默认为**开**）。注册方式是向
  `ctx.openai.settings` / `settingNames` 推入一个合成预设，只改内存不写盘。
- **自定义 API 连接**：与 Luker 的 Connection Profile 二选一使用。
  - 可填写自建端点、专属密钥，并从端点拉取模型列表供选择；
  - 密钥通过 `POST /api/secrets/write` 存入 Luker 服务端 secrets，
    请求时以 `apiSettingsOverride.secret_id` 引用 ——
    **不进入插件设置、不落盘、不回显**；
  - 通过 `generateTask(opts, { _injected: { profileResolver } })` 注入连接参数，
    且**只在某一层确实使用自定义连接时才注入**；走 Connection Profile 的层
    完全不受影响，不依赖任何半私有接口。
- 设置面板新增自定义连接管理卡片：新增 / 删除 / 保存密钥 / 拉取并选择模型；
  各层下拉框同时列出 Connection Profile 与自定义连接。
- 删除正在被使用的连接时会提示会影响哪几层，并把相关层回退为空。

### 变更

- 面板文案澄清了两件此前没讲清楚的事：准备层留空 = 内置纯净预设；
  渲染层留空 = 你当前激活的 RP 预设。
- 诊断报告新增「纯净预设」状态。

### 测试

- 新增 25 个用例：纯净预设 7 个、自定义连接 19 个（含 resolver 委托行为、
  密钥不落盘的断言）、设置面板一致性 6 个。总计 **60 个用例全部通过**。

## [0.2.1] — 未发布

### 修复（阻断性）

- **`jsonSchema` 载荷结构错误，导致前三层必然 400、插件完全不可用**。
  原实现按文档传了裸 JSON Schema，但服务端 provider 的实际契约是
  `{ name, value, strict }` —— schema 内容必须放在 `value` 字段里，
  provider 会组装成 `response_format.json_schema.schema`。
  传裸 schema 会让服务端拿到 `schema: undefined`，被上游拒绝：

  ```
  response_format.json_schema.schema is required
  ```

  后果是流水线在第一层就抛错并回滚，用户看到的是「多模型流水线失败，已回滚本回合」。
  现已改为 `wrapJsonSchema(name, value)` 统一包装，并显式 `strict: false`
  （我们的 schema 不满足 OpenAI 严格模式要求，多数中转也不支持）。

- **新增结构约束降级**：自建端点/中转不支持 `response_format` 时，自动去掉
  jsonSchema 重试一次。前三层的任务提示词里本就写了「严格返回 JSON」，
  足以兜底。限流（429）、鉴权（401/403）类错误不会被误判为可降级错误。

### 测试

- 新增 3 个用例：jsonSchema 载荷契约形状（防回归）、降级重试路径、
  非 schema 错误不重试。总计 **63 个用例全部通过**。

## [0.2.2] — 未发布

### 修复

- **响应阶段的结构化输出失败现在也会降级**。0.2.1 修好请求格式后暴露出下一个
  问题：部分端点/中转在**响应**阶段返回非标准形状，而 Luker 的
  `normalizeResponse` 在 jsonSchema 模式下只接受两种形状（JSON 字符串，或标准
  chat-completion 对象），其它形状会抛：

  ```
  json_schema_violation: jsonSchema response: unrecognized shape
  (expected string or chat-completion object)
  ```

  请求本身是成功的，只是无法拆包 —— 因此整回合回滚过于苛刻。现在同样会
  自动去掉结构约束重试一次。
- 降级判定改为**优先使用错误码**（`GenerateTaskError.code === 'json_schema_violation'`），
  字符串匹配仅作兜底；限流（429）/鉴权（401/403）依旧不会被误判为可降级错误。
- 降级日志带上错误码与原始信息，便于定位是请求侧还是响应侧的问题。

### 新增

- 设置项 `useJsonSchema`（默认开）：可彻底关闭结构化输出请求。
  若端点稳定不支持，关掉它比每回合多一次失败往返更划算 ——
  前三层的任务提示词里本就有「严格返回 JSON」约束，配合容错解析
  （可处理 ```json 围栏与前后废话）足以兜底。

### 测试

- 新增 3 个用例：响应阶段降级路径、关闭开关后完全不传 schema、
  `looksLikeSchemaUnsupported` 的判定边界（含 429/401/403 不误判）。
  总计 **66 个用例全部通过**。
