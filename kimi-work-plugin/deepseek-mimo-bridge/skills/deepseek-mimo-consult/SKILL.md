---
name: deepseek-mimo-consult
description: 用 ask_deepseek / ask_mimo 把问题转给 DeepSeek 或小米 MiMo 模型。适用于需要第二意见、代码审查、换模型视角、中文写作打磨时；一次只调一个模型，单次问答不带历史。
---

# DeepSeek / MiMo 转问指南

## 何时用

- 用户说「问一下 DeepSeek」「让 DeepSeek 看看」「MiMo 觉得呢」「换个模型回答」。
- 你需要一个外部模型的独立判断（第二意见、审稿、找漏洞），而不要在同一上下文里自我循环。
- 用户明确要求某个模型（DeepSeek / MiMo）或某个型号（`deepseek-flash` / `deepseek-v4-pro` / `mimo-v2.6-pro` / `mimo-v2.6-flash`）。

## 何时不用

- 用户没点名、任务也不复杂 → 直接用你自己的能力，不要为了用插件而调用。
- 用户要求「两个模型一起回答」→ 这是两次独立调用，分别调用后并列说明，不要假装是联合推理。
- 需要多轮追问 → 工具无历史，请把上一轮问答的关键内容拼进下一次 prompt。

## 工具速查

### ask_deepseek

| 参数 | 取值 | 说明 |
|---|---|---|
| `prompt` | 字符串，必填 | 完整问题 + 必要上下文 |
| `system` | 字符串 | 可选角色设定 |
| `model` | `deepseek-flash`（默认）/ `deepseek-v4-pro` | 复杂任务用 pro |
| `effort` | `off` / `low` / `high`（默认）/ `max` | 思考强度 |
| `max_tokens` | 数字 | 输出上限（含思考），默认 8192 |

返回：Markdown，含模型名、参数、耗时、tokens 与「思考过程（原文）」小节。

### ask_mimo

| 参数 | 取值 | 说明 |
|---|---|---|
| `prompt` | 字符串，必填 | 完整问题 + 必要上下文 |
| `system` | 字符串 | 可选角色设定 |
| `model` | `mimo-v2.6-pro`（默认）/ `mimo-v2.6-flash` | 高频批量用 flash |
| `thinking` | `on`（默认）/ `off` | 深度思考开关 |
| `max_tokens` | 数字 | 输出上限（含思考），默认 8192 |

### bridge_status

无参数。返回 JSON：Node 版本、插件目录、两家密钥是否检测到（掩码 + 来源）、端点、可用模型、上次调用记录。

## 调用姿势

1. **整理 prompt**：一段话说明任务 + 输入材料 + 期望输出格式（例如「只列问题，按严重程度排序，每条形如 `文件:行号 — 问题 — 修复建议`」）。
2. **只调一次**：拿到结果后判断是否够用；不够就把反馈补进新 prompt 再问一次，最多两轮。
3. **转述**：交付时标注「据 DeepSeek / MiMo」，保留其关键结论与限定条件；你可以在其基础上补充自己的判断，但要说清楚哪部分是谁说的。
4. **核对**：外部模型给的版本号、价格、日期、API 名称可能过期，交付前自行联网核实。

## 失败排查

| 现象 | 处理 |
|---|---|
| `缺少 API Key` | 调 `bridge_status` 看 `apiKey.found`；检查 `~/.dsh/.credentials.yaml`、环境变量或 `config.json` |
| `HTTP 401/403` | 密钥无效/过期/未授权该模型，提示用户去控制台更新 |
| `HTTP 404` | 模型名或 `baseUrl` 不对；对照 `bridge_status` 里的 models 与 baseUrl |
| `HTTP 429` | 限流：等几十秒重试一次，或改用 flash 型号 |
| 超时 | 缩短 prompt、降低 `max_tokens`，重试一次 |
| 空内容 | 多半被长度截断，提高 `max_tokens` 后重试 |

两次失败仍不通，直接把错误原文交给用户，不要继续重试或编造结果。
