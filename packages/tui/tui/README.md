# `@deepseek-ai/dsh-tui`

The dsh terminal surface: an in-process TUI plugin restructured after the **DamnatioX TypeScript TUI** (Ink 7 + React 19). v0.0.13 builds on the v0.0.12 surface ([TUI frontend plan](../../../dsh-TUI-前端完整方案.md)):

- **DamnatioX geometry**: a fixed-height root Box (`width × height` + `overflow="hidden"`) — the frame always fills the terminal, so Ink always takes its whole-screen clear path and no interleaved cursor write can ever corrupt the screen. Layout: 4-row header (`🐋 DSH-TUI` / cwd / model · busyEnter + a separator) · transcript viewport · slash picker · composer · status bar (activity row + Web-stats strip).
- **Toolkit-native caret**: the composer caret anchors through Ink's own `useCursor()`/`measureElement()` (no manual ANSI CUP writes anywhere). The single-line input renders a horizontal viewport around the caret with `…` ellipses and reserves one cell for the native cursor — Windows Terminal IME composition anchors at the draft.
- **DamnatioX wheel semantics, verbatim**: SGR wheel reports are parsed from Ink's raw input stream (`parseMouseWheel`), each tick moves the transcript by 3 lines (`scrollOffsetForWheel`), offset 0 is follow mode (submits reset it), new content while scrolled keeps the view anchored (`updateTranscriptMaximumOffset`), and a positive offset shows the floating back-to-bottom button. A **browser-style right-edge scrollbar** (`█` thumb on a `│` rail in its own gutter column) jumps straight to any history position on click or drag (2-cell target, 1002 button-motion tracking). PgUp/PgDn/Ctrl+Home/End page, `history paused` shows in the status bar.
- **Slash picker in the DamnatioX palette style**: `╭─` title / items / `╰─` hint rows, an 8-item window that follows the selection, ↑↓ cycles, Tab completes, Esc dismisses (until the input changes), Enter executes — no border-box rendering glitches.
- **dsh extras kept**: render-intent tool cards, retry countdown rows, markdown inline runs, the Web-stats strip, `/settings` five pages + `/jobs` `/subagents` `/workflows` panels, approval/question takeovers, busyEnter queue/steer, the queue dock, and the linear non-TTY fallback.
- **Duplicate-free rendering**: transcript viewport rows are position-keyed (scrolling reorders rows every wheel tick; keyed reordering through Ink's reconciler can accumulate stale rows) and the live Thinking/notice rows carry stable keys, so rapid wheel scrolling plus streaming keeps the screen clean — guarded by a screen-emulator regression test.
- **One Thinking block per turn**: reasoning segments split by tool calls merge into a single collapsible `✓ Thinking` row per turn (the TS DamnatioX shows one thought block per message entry) — a long agentic turn no longer stacks one Thinking row per tool call.
- **Web-stats strip** below the composer, folded deterministically from the session log: 轮次 / 步数 / LLM 时间 / 工具时间 / TTFT / tok/s / 缓存命中率 / ↑↓C W R Σ token 计数 / 上下文占用 —— nothing from the Web strip is omitted, and each turn closes with a `└ turn N · LLM · 工具 · TTFT` tail row.
- **Retry rows**: one muted, collapsible row per retry chain — `⟳ retry n/max · 12s 后` with a client-anchored countdown (ceil, 1s floor), shimmer while waiting, `∞` in always mode; the expand body shows provider/policy/failure code/HTTP status/latest delay and never the failure message (credential safety, Web parity).
- **Markdown inline styling**: assistant prose renders bold, inline code (cyan), links (underline), and emphasis as per-run colored segments, wrapped cell-accurately so styles survive line breaks; code fences, lists, and blockquotes stay structural, and GFM tables render as CJK-width-aligned `│` grids that shrink to the terminal width.
- **Busy-stream input safety**: Ink flushes a lone `\x1b` as Escape after 20ms, so a split arrow sequence under a busy stream used to wipe the draft and dismiss the picker; the renderer now confirms every Escape (60ms) and re-synthesizes the split key tail, keeping the picker open and arrow-navigable while a turn streams. The 100ms tick no longer re-projects settled nodes (the fold keeps settled arrays referentially stable, and tool-card bodies cap at 400 rows / 300 cells per line). Every fresh `/` keystroke re-arms the picker and each keystroke clears stale dismissals, so `/` can never stay silently suppressed.
- **Gradient chrome**: the live Thinking row cycles a LIGHT gradient (cyan → yellow → green, 800ms per color) with the fast spinner; a compaction run draws its own live gradient row (yellow → cyan → magenta) until it lands the `compacted` status row; the structured `/trajectory` view colors model turns blue, tool activity red, and user input cyan.
- **Fullscreen caret compensation**: the composer caret anchors through Ink's own `useCursor` with a +1 row compensation, because a fullscreen frame writes no trailing newline and Ink's cursor suffix counts from one line below it — the caret now sits exactly on the input row.
- **Tool render-intent cards**: every tool row projects its `presentCall`/`presentResult` view (generic / terminal / diff / search / read / web) into terminal blocks, collapsed by default.
- **`/settings` five pages**: general (busyEnter Queue/Steer, thinking default display — persisted to the `tui` namespace of `$DSH_HOME/settings.yaml`, live), models (provider/model catalog, default selection, value-free credential rows that write through `ctx.credentials` with masked input and a confirm gate), plugins (loader-tree inventory: `Enter` toggles a plugin on/off through the profile patch layer + launcher HMR, `c` opens its config editor), inventory (settings namespaces + credential refs + inspect providers), presets (agent presets: `Enter` recomposes the BLANK session in place — the Web mechanism; once the conversation starts its preset is fixed; the current preset is `●`-marked, broken presets are dimmed).
- **`/jobs` panel**: live registry rows (id/kind/label/status/elapsed/detail) refreshed every second while open; Enter requests a kill for running jobs. **`/subagents` panel**: the durable descendant tree (depth-indented, mode/activity/label, diagnostics). **`/workflows` panel**: event-driven run rows (status/phase/log/agent-count/error).
- **`/model`** opens the models settings page (select the default with Enter). **`/sessions`** lists the live agent plus the newest 50 persisted sessions (titles/filter), `Enter` resumes one with full history replay — exactly ONE live session exists at a time (switches dispose the previous agent; `/fork` yields a persisted, resumable artifact). **`/new`** starts a fresh session.
- **Collapsible rows** (context `◆`/Thinking/tool/retry): `↑↓` selects when the composer is empty, `Space` expands/collapses.
- **Slash picker** (`/`) over host commands plus TUI-local ones, listed **alphabetically (a–z)** in the DamnatioX palette style; host commands get Chinese descriptions in the zh locale and dispatch through `ctx.commands` without a model turn.
- **Approval and ask_user takeovers** (allow-once / deny / options / custom answers); **`/trajectory`** structured view; **todo and queue docks** at the transcript tail.
- **`Ctrl+Enter` steers** a running turn (`busyEnter` assigns plain Enter while busy); `Esc` cancels; `Ctrl+D` quits when idle; `Ctrl+L` clears; double `Ctrl+C` within 2s exits.

## Model Experience

### What the model sees

Nothing from this package. It registers no tools, no prompt sections, no dynamic context, and no title providers; the answerers and question provider only answer interactive prompts and never alter the request envelope.

### Token effect

None.

### KV Cache effect

None. The request envelope is byte-identical to a surface-less composition, so provider prompt-cache hit rates are unchanged by construction (the cache-safety contract in the TUI plan, §3.6).

## Web 功能差距核对（v0.0.12 · packages/client/* 对照）

| Web 功能 | TUI 状态 |
|---|---|
| 对话流、steer/queue 发送、busyEnter | ✅ 同款语义（运行中 Enter 按 busyEnter 走 Queue/Steer，Ctrl+Enter 互补） |
| 转录折叠（思考/工具/上下文）、工具渲染意图卡 | ✅ 六种意图卡 + retry 行 + 内联 markdown 着色 |
| 审批 allow-once/deny、ask_user（多选/自定义答案） | ✅ composer 上方接管区 |
| 轨迹视图 | ✅ `/trajectory` 切换 |
| 统计条（轮/步/LLM/工具/TTFT/缓存/token/上下文） | ✅ 状态栏 + 统计行（每轮尾部 `└ turn` 行） |
| 设置五页（general/models/plugins/inventory/presets） | ✅ `/settings`；凭据 value-free + write-only；预设页与 Web 同机制（空白会话原地切换） |
| 后台任务（列表/杀掉） | ✅ `/jobs`；⚠ 输出内联读取未做（注册表读游标归工具通知） |
| 子代理树 | ✅ `/subagents`（持久化后代树） |
| workflow 运行进度 | ✅ `/workflows`（事件驱动） |
| 会话侧栏/搜索/恢复 | ✅ `/sessions` 面板：live + 持久化会话（最近 50 条，含标题/时间），`/sessions <关键词>` 按 id/标题/模型过滤，Enter 用 `ctx.agents.resume` 恢复并重建转录；同一时刻仅一个 live 会话（切换即销毁旧 agent） |
| Agent 预设切换 | ✅ `/settings` presets 页 + `/presets`：空白会话 Enter 原地 recompose（agent-preset/selected 记录），会话开始后预设锁定——与 Web 同一机制 |
| reasoning effort 选择 | ✅ /settings models 页「推理等级」行组（Enter 选择；`llm.resolveModel` 暴露等级时显示，当前项标注） |
| 插件开关 | ✅ 插件页 **Enter 切换开关**（写 profile cordis.patch.yml，launcher HMR 热生效，行内 ●/○ 与亮/灰随热应用落地翻转）；`c` 打开该插件 settings 命名空间的配置编辑器：布尔 Enter 切换、字符串/数字/密钥字段 composer 编辑（密钥不回显）；嵌套对象只读 |
| 主题 / locale | ✅ `tui` 命名空间 `theme`（Dark 深色/Light 浅色调色板映射）与 `locale`（中文/English 界面语言）· /settings general 页 Enter 切换 |
| plan 模式条 / goal 面板 | ✅ 状态栏 `◈ plan`（含 pending 状态）+ transcript 尾 goal dock + `/goal` 详情 |
| 消息反馈 ↑↓（feedback） | ✅ ↑↓ 遍历全部行，选中助手消息后 `g` 赞 / `b` 踩，同分再按移除；持久化走 `message-feedback` sidecar（tui bundle 已挂 storage 链） |
| `/attach` 附件、`/workspace`/`/rename`、fork | ✅ `/rename <标题>`（sessionTitle.rename）、`/workspace <目录>`（chdir，新会话继承）、`/attach <图片>`（attachments.saveImage，随下一条消息发送 + dock）、`/fork [eventSeq]`（seed 分叉到新会话，可经 /sessions 恢复） |
| 交付文件 chips、@文件提及 | ✅ 工具卡 locations/files 行覆盖可见性；交互 chips/@提及补全留后续 |
| Ctrl+K 命令面板 | ⚠ 由 `/` 选择器覆盖（等价语义） |
| 图片粘贴 | ✅ 终端无位图粘贴通道；等价路径 `/attach <图片路径>` 走同一 attachments 服务（输入即入下一消息） |
| MessageList 虚拟化 | ✅ 最近 800 节点窗口 + 底部锚定视口（等效窗口化） |

## Known Limitations and Deferred Work

- **Non-TTY fallback is fail-closed**: the linear REPL mounts no answerer, so approval asks deny and `ask_user` fails — headless-strict semantics, matching `phi run`. TUI-local slash commands print a "linear mode" notice instead of leaking into a model turn.
- **The composer is single-line** (DamnatioX TS parity): Shift+Enter inserts a `↵`-rendered newline; the caret viewport scrolls horizontally with `…` ellipses.
- **Pending steering has no transcript bubble yet** (the queue dock shows the queued steer previews).
- **Mouse clicks are wired for the transcript only**: the right-edge scrollbar (click/drag jump) and the back-to-bottom button; click-to-toggle rows and text selection are deferred.
- **Markdown styling covers headings, paragraphs, and GFM tables**: list items and blockquote interiors stay plain text (remaining GFM pass).
