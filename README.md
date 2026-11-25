# 🔔 AgentNotices

> **专为 AI 编程会话打造的多模态任务完成提醒工具**  
> 原生打通 **Google Antigravity** · **Claude Code** · **OpenAI Codex CLI** · **Cursor** · **任意长耗时命令行任务**

无需 Electron、零运行时第三方 npm 依赖。macOS 原生 Swift/AppKit 弹窗（仅 ~200KB）+ Node.js 极速异步 Hook 引擎（< 20ms 返回，绝不阻塞 Agent），让你放心切走看文档、泡咖啡，任务一完成或需要确认立刻精准召回。

---

## ✨ 核心特性

- **原生打通四大 AI 编程工具**
  - **Google Antigravity**：原生支持 `~/.gemini/config/hooks.json`（`PreInvocation` 计时 + `Stop` 协议契约 + 离线读取 `transcript.jsonl` 尾部摘要 + 精准区分完成 / 报错 / 超限 / 用户取消）。
  - **Claude Code**：原生支持 `~/.claude/settings.json`（`UserPromptSubmit` / `Stop` / `Notification` 授权审批与等待输入提醒 + `stop_hook_active` 防递归）。
  - **OpenAI Codex CLI**：原生支持 `~/.codex/config.toml` 的 `notify` 回调。
  - **Cursor**：原生支持 `~/.cursor/hooks.json`（`beforeSubmitPrompt` + `stop`）。
  - **通用长命令包装**：`agent-notices run -- npm run build` 随时复用全套弹窗与推送能力。

- **三种原生 macOS 毛玻璃桌面弹窗形态（无视系统勿扰吞没、不抢输入焦点）**
  1. **`card`（角落悬浮卡片）**：跨 Space 与全屏应用置顶、悬停暂停倒计时、多条并发自动垂直堆叠、一键切回对应 IDE/终端窗口、一键「静音 30 分钟」。
  2. **`modal`（屏幕居中强提醒）**：面向长任务完成、报错或授权卡点的黄金居中大弹窗，支持常驻置顶直到手动确认、`Return` 一键切回、`Esc` 关闭。
  3. **`banner`（顶部灵动横幅）**：屏幕顶部胶囊横幅，轻盈不挡视野。
  - *Linux / Windows 自动降级为原生桌面通知 / PowerShell 提醒。*

- **智能分级与防打扰引擎**
  - **耗时阈值分级**：极短回合（默认 `< 5s`）自动静默；中等任务弹角落卡片；长任务（默认 `>= 30s`）或报错 / 等待审批自动升级为强弹窗与常驻模式。
  - **前台窗口防打扰**：可选在当前正盯着目标 IDE/终端时自动降级或静默。
  - **免打扰模式 & 定时静默时段（Quiet Hours）**：支持临时静音 N 分钟、跨零点夜间免打扰、会话去重防抖、用户手动取消默认静默。

- **多通道并发提醒**
  - 原生桌面弹窗 + macOS 通知中心（可选）
  - 分事件自定义提示音效（`afplay`）+ 中文/英文 TTS 语音播报（`say` 模板）
  - **7 大远程推送通道**（零依赖原生 `fetch`）：**飞书**（交互卡片 + HMAC-SHA256 签名）、**钉钉**（Markdown + 加签）、**企业微信**、**Bark (iOS)**、**Telegram Bot**、**ntfy**、**自定义 JSON Webhook**
  - **任务摘要**：默认离线秒级解析会话记录提取最后结论，也支持可选接入任意 OpenAI 兼容接口精炼摘要。

- **macOS 原生菜单栏常驻助手 + 本地 Web 配置控制台**
  - **菜单栏小助手（180KB 原生二进制）**：实时未读数字角标、一键免打扰/静音 30m、切换弹窗形态、点击最近完成记录直跳原工作窗口。
  - **本地 Web 控制台（`http://127.0.0.1:47890`）**：可视化配置所有策略与 Webhook、实时测试三种原生弹窗与各通道连通性、一键接入/卸载各 Agent Hooks、浏览完整提醒历史。

---

## 🚀 快速开始

### 1. 克隆并编译 macOS 原生弹窗与菜单栏助手

需要 **Node.js >= 20**（macOS 原生弹窗与菜单栏需 Xcode Command Line Tools 的 `swiftc`）：

```bash
git clone https://github.com/jzPPP3333/agent-notices.git
cd agent-notices

# 编译 macOS 原生 Swift 弹窗与菜单栏二进制（约 2 秒）
npm run build:macos

# 可选：全局链接 agent-notices / notices 命令
npm link
```

### 2. 立刻测试原生弹窗效果

```bash
# 角落悬浮卡片
node bin/agent-notices.mjs test --style card

# 屏幕居中常驻强弹窗
node bin/agent-notices.mjs test --style modal --kind attention --sticky

# 顶部灵动横幅
node bin/agent-notices.mjs test --style banner
```

### 3. 一键安全接入本地 AI 编程工具 Hooks

自动检测本机已安装的 Antigravity / Claude Code / Codex / Cursor，安全合并配置并自动创建 `.bak` 备份（绝不覆盖已有自定义 Hook）：

```bash
# 自动接入所有已检测到的工具
node bin/agent-notices.mjs install

# 或按需指定单个或多个工具
node bin/agent-notices.mjs install antigravity claude

# 查看接入状态
node bin/agent-notices.mjs status
```

### 4. 启动菜单栏助手 & Web 配置控制台

```bash
# 启动 macOS 顶部菜单栏常驻铃铛助手
node bin/agent-notices.mjs menubar

# 启动并打开本地 Web 可视化配置与通知中心
node bin/agent-notices.mjs ui --open
```

---

## 🛠️ 常用 CLI 命令

```bash
agent-notices install [auto|all|antigravity|claude|codex|cursor]   # 一键安全接入 Hooks
agent-notices uninstall [all|antigravity|claude|codex|cursor]      # 安全卸载 Hooks
agent-notices status [--json]                                      # 查看配置与接入状态
agent-notices test [--style card|modal|banner] [--kind done|attention|error] [--sticky]
agent-notices send --title "构建完成" --message "耗时 2m" --style modal
agent-notices run -- npm run build                                 # 包装任意长命令，结束自动提醒
agent-notices dnd [on|off|--minutes 30]                            # 免打扰 / 临时静音
agent-notices menubar                                              # 启动 macOS 菜单栏助手
agent-notices ui [--port 47890] [--open]                           # 启动本地 Web 配置控制台
agent-notices history [read-all|clear] [--limit 20]                # 历史记录管理
agent-notices config [show|path|get <key>|set <key> <value>]       # 读写 ~/.config/agent-notices/config.json
```

---

## 🏗️ 架构设计

```text
Antigravity / Claude Code / Codex / Cursor (Sync Hook)
        │  stdin JSON
        ▼
bin/agent-notices.mjs hook <agent>
  ├─ 解析标准协议 & 计算耗时 (< 20ms)
  ├─ 立即输出标准协议响应到 stdout (绝不阻塞 Agent)
  └─ detached spawn 后台 worker (src/worker.mjs)
        │
        ▼
  摘要提取 (transcript.jsonl / 可选 LLM)
        │
        ▼
  智能分级策略引擎 (src/policy.mjs)
  [耗时阈值 · 免打扰/夜间静默 · 前台窗口检测 · 去重防抖]
        │
        ├──▶ macOS Swift AppKit 原生弹窗 (card / modal / banner + 一键切回窗口)
        ├──▶ 提示音效 (afplay) & 语音播报 (say TTS)
        ├──▶ 系统通知中心 (可选)
        ├──▶ 远程多通道 (飞书 / 钉钉 / 企微 / Bark / Telegram / ntfy / Custom)
        └──▶ 本地历史记录 + macOS 菜单栏角标同步 + Web 控制台
```

---

## 🧪 运行测试

```bash
npm test
```

## 📄 License

[MIT](./LICENSE)
