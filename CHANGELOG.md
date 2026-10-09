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
