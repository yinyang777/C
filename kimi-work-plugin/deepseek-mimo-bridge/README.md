# deepseek-mimo-bridge · Kimi Work / Kimi Code 插件

在 Kimi Work 与 Kimi Code 里**按需转问**两个外部大模型：

- **DeepSeek**：`deepseek-flash`（默认，快）/ `deepseek-v4-pro`（复杂任务）
- **小米 MiMo**：`mimo-v2.6-pro`（默认）/ `mimo-v2.6-flash`

一次只调一个模型、一问一答（无历史记忆），拿回完整回答与思考过程，由 Kimi 转述整合。
**不会**把同一个问题同时丢给两个模型——除非你自己要求对比。

---

## 1. 安装

### 方式 A：一键脚本（推荐，本机已适配）

```powershell
cd C:\Users\25398\Desktop\kimi-work-plugin\deepseek-mimo-bridge
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Target both
```

两个宿主机制不同，脚本分别处理：

| 宿主 | 脚本做什么 | 你还要做什么 |
|---|---|---|
| **Kimi Work** | 调用 Kimi 自带的 Plugin Builder 登记脚本，写入个人插件市场 `daimon/plugin-market/personal/deepseek-mimo-bridge.json`（含图标/多语言/校验） | 打开「插件 → **个人**」页签，点 **＋** 安装（daemon 热重载，**不用重启**） |
| **Kimi Code** | 复制到 `~/.kimi-code/plugins/managed/deepseek-mimo-bridge/` 并写入 `plugins/installed.json`（严格 JSON、**无 BOM**） | 重启 Kimi Code（或 `/reload`） |

要点：
- Kimi Work 的个人插件**不会**出现在「已安装」页签（那是账号级官方/精选），只在「**个人**」里。
- 脚本会自动备份被改动的 `installed.json`（`*.bak-<时间戳>`）。
- **登记后别删这个源目录**（`C:\Users\25398\Desktop\kimi-work-plugin\deepseek-mimo-bridge`）：个人市场登记记录里的 `sourcePath` 指向它，之后更新插件也改这里再重跑脚本。

### 方式 B：Kimi Code CLI 原生命令

```bash
/plugins install C:\Users\25398\Desktop\kimi-work-plugin\deepseek-mimo-bridge
/reload
```

等价的 daemon 命令（Kimi Work 的托管目录也能用，装完**需重启客户端**，其 `existingProcessBehavior` 会返回 `restart-required`）：

```powershell
& "$env:APPDATA\kimi-desktop\daimon-bundle\bin\kimi-daimon.cmd" --node "E:\node.exe" `
  kimi-plugin install "C:\Users\25398\Desktop\kimi-work-plugin\deepseek-mimo-bridge" `
  --home "$env:APPDATA\kimi-desktop\daimon-share\daimon\runtime\kimi-code\home" --json
```

### 方式 C：手动登记到 Kimi Work 个人市场

等价于脚本内部做的事（需要 Kimi Work 已启动过一次，脚本会复用它的 Plugin Builder 与 kimi-daimon）：

```powershell
python "$env:APPDATA\kimi-desktop\daimon-share\daimon\skills\plugin-builder\scripts\register_personal.py" `
  "C:\Users\25398\Desktop\kimi-work-plugin\deepseek-mimo-bridge" `
  --share-dir "$env:APPDATA\kimi-desktop\daimon-share" `
  --daimon-bin "$env:APPDATA\kimi-desktop\daimon-bundle\bin\kimi-daimon.cmd" `
  --node "E:\node.exe" --confirm-rights
```

### 前置条件

- Node.js ≥ 18（本机是 `E:\node.exe`，v24.15.0，已满足）。插件 `mcpServers` 里写的是 `node`，宿主进程能找到 PATH 即可。
- 若宿主环境找不到 `node`，把 `kimi.plugin.json` 里 `mcpServers.bridge.command` 改成绝对路径，例如 `E:\\node.exe`。
- Kimi Work 方式还需要 Python（本机 3.13 已装），登记脚本用它做校验。

---

## 2. 密钥

优先级（从高到低）：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | 环境变量 `DEEPSEEK_API_KEY` / `MIMO_API_KEY` | 临时覆盖，适合调试 |
| 2 | 插件目录 `config.json` 的 `providers.<id>.apiKey` | 见 `config.example.json` |
| 3 | `~/.dsh/.credentials.yaml` 的 `refs` 段 | DeepSeek → `DEEPSEEK_API_KEY`；MiMo（小米）→ `XIAOMI_API_KEY` |

密钥不会被复制进插件目录；`bridge_status` 只回显掩码（如 `sk-…f84f`）和来源。

**当前实测状态（2026-11-08 22:2x）**：两家密钥均有效，已各真实调通（`6/6 通过`）：
`ask_deepseek` 4.1s / 487 tokens（含思考 457），`ask_mimo` 11.3s / 155 tokens（含思考 124）。

> 注意：外部模型对「自己是哪个版本」的自述经常过期（实测 DeepSeek 自称 V3.2/128K、MiMo 自称知识截止 2024），
> 这类身份类问题不要当事实用；版本与上下文长度以官方文档为准。

---

## 3. 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `ask_deepseek` | `prompt`(必填)、`system`、`model`、`effort`(`off/low/high/max`)、`max_tokens` | 转问 DeepSeek，返回正文 + 思考过程 |
| `ask_mimo` | `prompt`(必填)、`system`、`model`、`thinking`(`on/off`)、`max_tokens` | 转问 MiMo，同上 |
| `bridge_status` | 无 | 自检：密钥来源与掩码、端点、模型、上次调用 |

自检命令（不经 Kimi，直接以 MCP 协议对话）：

```powershell
node .\test\mcp-smoke.mjs            # 握手 + 列工具 + 两家真调一次
node .\test\mcp-smoke.mjs --offline  # 只验协议与密钥检测，不发请求
```

---

## 4. 在 Kimi 里怎么用

自然语言：

- 「让 DeepSeek 把这段代码审一下，挑真正会出问题的地方」
- 「换 MiMo 重新回答我刚才的问题」
- 「问一下 DeepSeek 这个方案有什么风险」

斜杠命令：

- `/deepseek-mimo-bridge:ask-deepseek <问题>`
- `/deepseek-mimo-bridge:ask-mimo <问题>`

插件启用期间会自动注入 `SYSTEM.md` 的行为规则：一次只用一个模型、不伪造调用、工具无历史需自带上下文、外部模型的版本/价格/日期要再核实。

---

## 5. 排错

| 现象 | 原因与处理 |
|---|---|
| Kimi 里看不到插件/工具 | 装完没重启宿主；或 `installed.json` 未登记。重开客户端，或看 `/plugins info deepseek-mimo-bridge` |
| 「插件」页空白 / 提示「无法读取已安装插件列表」 | `installed.json` 被写入了 **UTF-8 BOM**，Kimi 严格解析报 `Unexpected token '﻿'`。重跑 `install.ps1`（已改为无 BOM 写入）后重开客户端；不要用记事本直接改该文件 |
| `缺少 API Key` | 跑 `bridge_status` 看 `apiKey.found`；按第 2 节补密钥 |
| `HTTP 401/403` | Key 无效/过期/未授权。DeepSeek 去 platform.deepseek.com 重建；MiMo 去 platform.xiaomimimo.com 重建 |
| `HTTP 404` | `baseUrl` 或模型名不对（MiMo 必须带 `/v1`） |
| `HTTP 429` | 限流：等几十秒，或换 flash 型号 |
| 超时 | 缩短 prompt / 降低 `max_tokens`，重试一次 |
| 空内容 | 多为长度截断，提高 `max_tokens` |
| 宿主找不到 node | `kimi.plugin.json` 里 `command` 改成 `E:\\node.exe` |

---

## 6. 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall -Target both
```

或 Kimi Code：`/plugins remove deepseek-mimo-bridge`。

---

## 7. 结构

```
deepseek-mimo-bridge/
├─ kimi.plugin.json          # manifest：MCP + skills + commands + systemPrompt
├─ SYSTEM.md                 # 插件启用期注入的行为规则
├─ server/index.mjs          # 零依赖 MCP stdio 服务（JSON-RPC 2.0，按行分隔）
├─ skills/deepseek-mimo-consult/SKILL.md
├─ commands/ask-deepseek.md · ask-mimo.md
├─ config.example.json       # 端点/模型/密钥来源覆盖示例
├─ test/mcp-smoke.mjs        # 本地冒烟测试
└─ install.ps1               # 安装/更新/卸载
```

## 8. 事实来源（查证 2026-11-08）

- Kimi 插件规范：[Kimi Code Plugins](https://www.kimi.com/code/docs/kimi-code-cli/customization/plugins.html)
- DeepSeek 模型与价格：`deepseek-flash` / `deepseek-v4-pro`，BASE `https://api.deepseek.com`（[文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）
- DeepSeek 思考模式：`thinking:{type:enabled|disabled}` + `reasoning_effort`（[文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)）
- MiMo 模型：`mimo-v2.6-pro` / `mimo-v2.6-flash` / `mimo-v2.6-pro-ultraspeed`，BASE `https://api.xiaomimimo.com/v1`（[文档](https://mimo.mi.com/docs/zh-CN/quick-start/summary/model)）
- MiMo 深度思考：`thinking:{type:enabled|disabled}`，默认开启（[文档](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/deep-thinking)）
