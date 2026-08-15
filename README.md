<p align="center">
  <a href="#install--run"><img alt="Node 22" src="https://img.shields.io/badge/NODE-22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white"></a>
  <a href="#technical-architecture"><img alt="React 19" src="https://img.shields.io/badge/REACT-19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB"></a>
  <a href="#technical-architecture"><img alt="TypeScript" src="https://img.shields.io/badge/TYPESCRIPT-3178C6?style=for-the-badge&logo=typescript&logoColor=white"></a>
  <a href="#technical-architecture"><img alt="Ink 7" src="https://img.shields.io/badge/INK-7-3A3A3A?style=for-the-badge"></a>
  <a href="#install--run"><img alt="Harness V2" src="https://img.shields.io/badge/HARNESS-V2-8B5CF6?style=for-the-badge"></a>
  <a href="#all-features--usage"><img alt="Local TUI" src="https://img.shields.io/badge/TUI-REACT%20%7C%20INK-EC4899?style=for-the-badge"></a>
</p>

<p align="center"><strong>English</strong> · <a href="#简体中文">简体中文</a> · Local-first · Session persistence · Tool runtime</p>

# DeepSeek Harness TUI (`dsh-tui`)

> ⚠️ **Final development stage.** This repository is still under active development.
> Packaging and publishing are **NOT done yet** — everything runs from the local
> workspace (`pnpm dsh --profile tui`). There will be breaking changes.

<p align="center">
  <img src="assets/tui-session-chat.png" alt="dsh-tui session screenshot" width="46%">
  <img src="assets/tui-session-panel.png" alt="dsh-tui settings panel screenshot" width="46%">
</p>

`dsh-tui` is a **local terminal frontend** for the DeepSeek Harness agent runtime,
built with **React 19 + Ink 7 + TypeScript** on the Cordis plugin framework. It is
an in-process plugin (`@deepseek-ai/dsh-tui`) that folds the event-sourced session
log into a live terminal UI: thinking shimmer, streaming replies, render-intent
tool cards, permissions, slash-command palette, panels, and a width-safe
DeepSeek whale welcome banner.

---

## Quick Jump

- [Developer preview status](#developer-preview-status)
- [Requirements](#requirements)
- [Install & Run](#install--run)
- [All features & usage](#all-features--usage)
- [Technical architecture](#technical-architecture)
- [TUI ↔ Web comparison](#tui--web-comparison)
- [Repository layout](#repository-layout)
- [简体中文](#简体中文)

---

## Developer preview status

- **In final development stage.** Packaging, publishing, and an installer are
  **not implemented yet**.
- Run from source or from the local build only; see [Install & Run](#install--run).
- The **original** `deepseek-harness` repository is never modified — this
  repository is a separate full copy that adds the TUI on top.

## Requirements

| | |
| --- | --- |
| Node.js | `^22.19 \|\| >=24` |
| Package manager | `pnpm` (plain `pnpm`, no `corepack` required) |
| Terminal (primary) | Windows Terminal + PowerShell + Cascadia Mono |
| Terminal (secondary) | WSL / Linux terminal + JetBrains Mono |
| API key | `DEEPSEEK_API_KEY` (env or the in-app credentials page) |

## Install & Run

```sh
pnpm install
```

### Run from source

```sh
pnpm dsh --profile tui
```

> ~19.6s startup (tsx transpiles package by package). Use the built fast path
> for daily use:

```sh
pnpm run build          # once, after install or after source changes
pnpm exec dsh --profile tui   # ~2.7s
```

The first-load screen prints the DeepSeek whale banner; type a task and press
**Enter**. Type `/help` for the command catalog.

## All features & usage

### Composer & input

| Action | Keys |
| --- | --- |
| Send message | `Enter` |
| Hard newline in the draft | `Shift+Enter` |
| Steer (jump the queue while busy) | `Ctrl+Enter` |
| Shell-style input history | `↑` / `↓` (empty draft) |
| Draft wrapping | up to 5 lines, wraps at cell width |
| Paste | terminal paste / `usePaste` (control sequences sanitized) |
| Input size limit | 900 KB (frontend-checked) |
| IME | supported (native cursor anchoring, no caret corruption) |

### Slash commands

| Command | What it does |
| --- | --- |
| `/help` | show the full command catalog |
| `/clear` | clear the transient notice (session kept) |
| `/trajectory` | toggle the structured trajectory view (blue=model, red=tools, cyan=user) |
| `/model` | open the Models page to pick the default model |
| `/settings [general\|models\|plugins\|inventory]` | open the four settings pages |
| `/jobs` | background jobs panel (`Enter` kills the selected job, 1s polling) |
| `/subagents` | subagent tree panel (depth-indented, live activity) |
| `/workflows` | workflow run progress panel |
| `/sessions [filter]` | list live + persisted sessions, `Enter` resumes one (full history replay) |
| `/effort off\|high\|max` | set/clear the reasoning effort on the current route |
| `/goal` | current goal details (phase, rounds, objective) |
| `/rename <title>` | rename the session title |
| `/workspace <dir>` | switch the working directory (applies to this and future sessions) |
| `/attach <image>` | attach png/jpg/gif/webp to the next message |
| `/fork [seq]` | fork the session at the last completed turn (or the turn containing `seq`) |
| `/new` | start a fresh session |
| `/quit` / `/exit` | save and exit |

Typing `/` opens the **command palette**: `↑`/`↓` select, `Enter` run,
`Tab` complete arguments, `Esc` dismiss. Unknown `/…` lines fall through to the
registered host commands, and unknown text becomes a model message.

### Keyboard & mouse map

| Key | Action |
| --- | --- |
| `Shift+Tab` | rotate the session file-policy mode `read-only → workspace-write → danger-full-access` (pinned colored bar: white/yellow/red) |
| `Ctrl+C` | cancel the running turn; press again within 2s to exit |
| `Ctrl+L` | clear the notice and the draft |
| `Ctrl+D` | exit (idle, empty draft) |
| `Tab` (empty draft) | enter message-selection mode |
| `↑` / `↓` (selection mode) | walk transcript nodes |
| `Space` (selection mode) | expand/collapse Thinking/context/tool/retry bodies |
| `g` / `b` (selection mode) | 👍 / 👎 feedback on the selected assistant message |
| `Esc` | leave selection mode / close panel / cancel (busy) |
| `PgUp` / `PgDn`, `End`, `Ctrl+Home` | page the transcript |
| Mouse wheel | scroll transcript (3 lines/tick) or open panel |
| Mouse click | floating centered back-to-bottom button (appears when scrolled up) |
| Panel keys | `↑`/`↓` select · `Enter` activate · `q` close · `Tab` switch settings page · `c` edit a plugin's config (plugins page) |

### Display features

- **Welcome banner** — the DeepSeek whale in single-cell `█ ▓ ▒ ░` blocks (13 rows)
  plus a 6-row 3D `DEEPSEEK HARNESS` title (`█` glyphs + `░` shadow). Stored as a
  raw multi-line string, centered with terminal-cell width math, and it degrades
  to a compact welcome card on narrow terminals — it never wraps and never uses
  fallback-prone glyphs.
- **Thinking** — live grayscale shimmer over the spinner-led `Thinking` label,
  one-row tail preview, settled rows show a `0.1s`-precision duration and can be
  expanded (`Space`, or always-expanded via the settings toggle).
- **Streaming** — assistant text streams with a trailing caret; completed turns
  render as full Markdown (GFM tables, code blocks, runs; no syntax highlighting).
- **Tool cards** — the same `presentCall` / `presentResult` render-intent
  projection as the Web UI, terminal-styled, over-long cards truncated.
- **Retries** — folded retry chains with live countdown shimmer.
- **Compaction** — live `compacting…` gradient row while a compaction runs.
- **Stats strip** — `轮/步/LLM/工具/TTFT/tok` + tokens + **context occupancy**
  (live `contextPressure` projection) + the current reasoning effort, always
  highlighted.
- **Docks** — queued-input preview (`⧗`), todo counts, goal status, image
  attachment chips ride the bottom of the transcript.
- **Approvals & questions** — full-screen takeover: `y`/`Enter` allow once,
  `n`/`Esc` deny; `ask_user` questions: `↑`/`↓` choose, or type a custom answer.
- **Terminal title** — sets `🐋 DeepSeek Harness` on the tab and restores the
  previous title on exit.
- **Non-TTY fallback** — piped/CI runs fall back to a line-driven plain renderer
  with fail-closed answerers.

### Sessions & settings

- **Single agent per process.** `/new` swaps to a fresh session; `/sessions`
  resumes any persisted one (the transcript is replayed from the authoritative
  log, so the complete history comes back).
- **Settings (4 pages):** General (`busyEnter` queue/steer, Thinking
  collapsed/expanded, theme dark/light, locale zh/en), Models (catalog +
  adapter reasoning levels), Plugins (per-namespace top-level field editor:
  bool/string/number/secret, values never echoed), Inventory (namespaces,
  secret slots, credential refs, loader tree).
- **Plugin toggle:** `Enter` on a plugin row flips it — the switch writes
  `$DSH_HOME/profiles/<name>/cordis.patch.yml` and the launcher's HMR watch
  hot-applies it; the `●`/`○` dot flips live.
- **Credentials:** `Enter` on a credential row edits the value (masked, supports
  removal); never displayed.

## Technical architecture

### Layered view

```text
pnpm dsh --profile tui
  └─ node --import tsx/esm apps/cli/src/bin.ts --profile tui     (source; lib/bin.js built)
      └─ Cordis plugin tree — tui bundle (base + tui-app)
          └─ @deepseek-ai/dsh-tui   (packages/tui/tui/src/index.ts)
              ├─ boot(): one process-wide Agent (ctx.agents.create)
              ├─ subscribe(): internal/dispatch → session/event, agent/status
              │    → applyEvent(fold, event, scratch) → store.set(snapshot)
              ├─ mountAnswerers(): approval + ask_user providers (answer ONLY)
              └─ runInk(store, host) → Ink 7 <App/> render
```

### Module map (`packages/tui/tui/src/`)

| Module | Responsibility |
| --- | --- |
| `index.ts` | Cordis plugin host: agent creation, event subscription, host commands, answerers, TTY/non-TTY branch. Registers **no tools, no prompt sections, no providers** — the request envelope stays byte-identical to the surface-less composition (KV-cache-safe). |
| `fold.ts` / `types.ts` | Event-sourced fold: `initialState`, `applyEvent`, `foldFromLog` (resume replay), `anchorRetry`; `TuiNode` = user/context/assistant/think/tool/retry/status. |
| `store.ts` | `createTuiStore` — getSnapshot/subscribe/set, consumed via `useSyncExternalStore`. |
| `render.tsx` | The Ink 7 app: full-screen frame (`alternateScreen: true`), header, transcript viewport, permission bar, composer, status bar, panels, takeover, palette; `runInk(store, host)`. |
| `viewport.ts` | Pure cell-width math: `selectTranscriptViewport` (bottom-anchored scroll offset), `selectPanelViewport`, `selectComposerLayout` (input wrap + caret line). |
| `welcome-banner.ts` | Immutable whale art (`WHALE_ART_RAW` raw multi-line string, `█ ▓ ▒ ░` only) + precomputed 3D title rows (`buildTitleRows`); degrade ladder, never wraps. |
| `plain.ts` | Line-driven fallback renderer + shared pure helpers: markdown lines/runs, GFM tables, stats strip, help text, welcome card. |
| `card-project.ts` | `presentCall`/`presentResult` render-intent projection into terminal cards. |
| `settings-data.ts` | Panel row builders for the four settings pages, jobs, subagents, workflows, sessions. |
| `patch-toggle.ts` | Plugin on/off: edits `profiles/<name>/cordis.patch.yml` (bare ids, `[]` restore) for HMR hot-apply. |
| `mouse.ts` | SGR wheel/click parsing (`?1000h`/`?1006h` capture) for in-app scrolling and the back-to-bottom button. |
| `csi-arbiter.ts` | Split-ESC arbitration so lone `Esc` / split arrow keys never corrupt input. |
| `sanitize.ts` | Strips CSI/OSC/control sequences from model output, tool results, and pastes. |

### Data flow & guarantees

- **Model-visible ⟺ logged:** the UI only projects the event-sourced session
  log; it never fabricates state.
- **KV-cache-safety:** the TUI contributes zero tools / prompt sections /
  providers; the approval answerer and `ask_user` provider only *answer*
  interactive questions.
- **Deterministic resume:** `/sessions` resume replays `foldFromLog` over the
  authoritative corpus read (persistence repair included).
- **Caret & IME:** the composer caret is anchored through Ink's own
  `useCursor`/`measureElement` (no manual CUP writes).
- **Resize-safe:** the root frame fills exactly the physical rows; narrow
  windows truncate chrome, the banner degrades instead of wrapping, and the
  frame budget clamps palette/takeover so the composer is never overwritten.
- **Render-intent parity:** tool presentation reuses the same
  `presentCall`/`presentResult` intent protocol as the Web UI.

## TUI ↔ Web comparison

A full feature-by-feature checklist of this TUI against the Web frontend lives
in **[TUI-WEB-COMPARISON.md](TUI-WEB-COMPARISON.md)** — jump there for the
per-feature ✅/🟡/❌/➕ matrix (sessions, rendering, approvals, panels,
permissions, keyboard/mouse, performance, and the known-limitations list).

## Repository layout

```text
packages/tui/tui/          the TUI plugin (@deepseek-ai/dsh-tui): src + tests
apps/cli/                  the dsh CLI that boots profiles (incl. --profile tui)
assets/                    README screenshots
TUI-WEB-COMPARISON.md      feature-by-feature TUI ↔ Web comparison
```

Everything else in this repository is the DeepSeek Harness workspace the TUI
plugs into (core/llm/tools/web packages, vendor/Cordis, …) — the original
`deepseek-harness` repository is kept untouched.

---

## 简体中文

### 项目状态

**处于最后开发阶段**：打包、发布、安装器**尚未实现**。当前只能从源码或本地构建产物运行。本仓库是原 `deepseek-harness` 仓库的完整副本 + TUI 插件，**原仓库零改动**。

### 安装与运行

```sh
pnpm install
pnpm dsh --profile tui        # 源码启动（tsx 转译，约 19.6s）
pnpm run build
pnpm exec dsh --profile tui   # 构建产物启动（约 2.7s，推荐日常使用）
```

首屏显示鲸鱼横幅，输入任务后按 **Enter**；输入 `/help` 查看全部命令。

### 全部功能用法（速查）

**输入**：`Enter` 发送 · `Shift+Enter` 硬换行 · `Ctrl+Enter` steer · `↑/↓` shell 式输入历史 · 草稿最多 5 行自动换行 · 支持粘贴与 IME · 900KB 输入上限。

**斜杠命令**：`/help` 帮助 · `/clear` 清提示（会话保留）· `/trajectory` 轨迹视图 · `/model` 选模型 · `/settings [general|models|plugins|inventory]` 四页设置 · `/jobs` 任务面板（Enter 杀任务）· `/subagents` 子代理树 · `/workflows` workflow 进度 · `/sessions [过滤]` 会话列表（Enter 恢复，完整历史重放）· `/effort off|high|max` 推理力度 · `/goal` 目标详情 · `/rename <标题>` 重命名 · `/workspace <目录>` 切换工作目录 · `/attach <图片>` 附加图片 · `/fork [seq]` 分叉会话 · `/new` 新会话 · `/quit`/`/exit` 保存退出。`/` 会弹出命令面板（↑↓ 选择、Enter 执行、Tab 补全、Esc 取消）。

**按键**：`Shift+Tab` 轮换沙箱权限 `read-only → workspace-write → danger-full-access`（输入栏上方白/黄/红常驻）· `Ctrl+C` 取消回合、2 秒内再按退出 · `Ctrl+L` 清提示与草稿 · `Ctrl+D` 退出 · `Tab` 进入消息选择模式（↑↓ 移动、Space 展开/折叠、g 赞 / b 踩、Esc 返回）· `PgUp`/`PgDn`/`End`/`Ctrl+Home` 翻页 · 滚轮滚动转录或面板 · 上翻时点击居中反色"回到底部"按钮 · 面板内 `q` 关闭、`c` 编辑插件配置。

**显示**：宽度安全鲸鱼横幅（`█▓▒░` 单格字符 + 6 行立体标题，窄终端降级为欢迎卡片、绝不折行）· Thinking 灰度微光 + 0.1s 耗时 + 可展开 · 流式回复 · 与 Web 同源的工具渲染意图卡片 · 重试倒计时微光 · compaction 实时渐变行 · 底部统计条（轮/步/LLM/工具/TTFT/tok + 上下文占用 + effort 常驻高亮）· 队列/todo/goal/附件 dock · 审批与 ask_user 覆盖层 · 终端标签标题（🐋，退出时恢复原标题）· 非 TTY 环境自动降级为行式输出。

### 技术架构

`dsh-tui` 是 **Cordis 进程内插件**（`@deepseek-ai/dsh-tui`），仅在 `--profile tui` 的 bundle 中加载。启动后创建**一个进程级 Agent**，通过 `internal/dispatch` 全局通道订阅 `session/event` 与 `agent/status`，用 `fold.ts` 把事件源会话日志折叠为 `TuiNode` 树（user/context/assistant/think/tool/retry/status），发布到 `store.ts` 的 `useSyncExternalStore` 快照。渲染层是 **Ink 7 + React 19** 的全屏帧（`alternateScreen: true`）：`render.tsx` 负责 header / 转录视窗 / 权限栏 / 输入框 / 状态栏 / 面板 / takeover / 命令面板；`viewport.ts` 用终端 cell 宽度做窗口化与光标行计算；`welcome-banner.ts` 保存原始多行鲸鱼横幅；`sanitize.ts` 清洗所有进入界面的控制序列。

三条硬保证：**① 模型可见 ⟺ 落盘**（界面只投影会话日志）；**② KV-cache 安全**（不注册任何工具/提示段/Provider，请求信封与无界面组合字节一致）；**③ 确定性恢复**（resume 从权威日志重放完整历史）。光标由 Ink 自身 `useCursor`/`measureElement` 锚定，无手工光标序列；窗口 resize 安全（帧恰好铺满物理行、横幅降级不折行、预算钳制保证输入框永不被覆盖）。

### TUI ↔ Web 对比

逐功能对比清单见 **[TUI-WEB-COMPARISON.md](TUI-WEB-COMPARISON.md)**（会话/渲染/审批/面板/权限/键鼠/性能/缺失清单，按 ✅/🟡/❌/➕ 标记）。
