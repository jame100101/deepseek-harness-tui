/**
 * The Ink 7 terminal renderer, restructured after the DamnatioX TypeScript
 * TUI: a fixed-height root Box (full-screen frames, so Ink always takes its
 * whole-screen clear path), a transcript viewport driven by a bottom-anchored
 * scroll offset with mouse-wheel/paging input parsed straight from Ink's
 * input stream, a single-line `› ` composer whose caret is anchored through
 * Ink's own `useCursor`/`measureElement` (no manual CUP writes), and the dsh
 * extras layered in: render-intent tool cards, retry rows, markdown runs,
 * the Web-stats strip, slash picker, panels, and approval takeovers.
 * @module @deepseek-ai/dsh-tui/src/render
 */

import React, { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Box, Text, measureElement, render, useApp, useCursor, useInput, usePaste, useStdout,
} from 'ink'
import type { DOMElement, Key } from 'ink'
import stringWidth from 'string-width'
import { projectCallCard, projectResultCard } from './card-project'
import { csiTailKey, escapeArbiter, syntheticKey } from './csi-arbiter'
import {
  DISABLE_WHEEL_MOUSE, ENABLE_WHEEL_MOUSE, parseMouseReport, parseMouseWheel, scrollOffsetForWheel, stripMouseReports,
} from './mouse'
import { formatStats, helpText, markdownLines, retryCountdownSeconds, welcomeBlock, wrapRuns, fitStatsStrip } from './plain'
import { welcomeBanner } from './welcome-banner'
import type { MdRun } from './plain'
import { sanitizeTerminalText } from './sanitize'
import {
  buildJobsRows, buildPluginConfigRows, buildSessionRows, buildSettingsRows, buildSubagentRows, buildWorkflowRows, SETTINGS_PAGES,
} from './settings-data'
import type { PanelRow, SettingsPageId } from './settings-data'
import type { TuiStore } from './store'
import type { TuiNode } from './types'
import {
  nextCodePointBoundary, previousCodePointBoundary, scrollOffsetForScrollbarRow, selectComposerLayout, selectPanelViewport,
  selectScrollbar, selectTranscriptViewport,
} from './viewport'
import type { TranscriptLine } from './viewport'

const MAX_POPUP_ITEMS = 8
const CTRL_C_EXIT_WINDOW_MS = 2_000
const MAX_TURN_INPUT_BYTES = 900_000
/** Cap on wrapped tool-card body rows: a giant card must not flood the frame. */
const MAX_TOOL_CARD_ROWS = 400

/** UI chrome language. */
type Locale = 'zh' | 'en'

/** Chrome copy keys (transcript content stays model/user-owned). */
interface Copy {
  idle: string
  busyCancel: string
  queued: string
  historyPaused: string
  plan: string
  planPending: string
  placeholder: string
  credentialPlaceholder: string
  secretPlaceholder: string
  numberPlaceholder: string
  stringPlaceholder: string
  paletteTitle: string
  paletteHint: string
  noMatch: string
  selAssistant: string
  selCollapsible: string
  approval: string
  allowOnce: string
  deny: string
  approvalHint: string
  questionHint: string
  questionInput: string
  goalDock: string
  todoDock: string
  queueDock: string
  thinking: string
  generating: string
  callingTools: string
  awaiting: string
  turn: string
  effort: string
  effortChanged: (effort: string) => string
  effortUsage: string
  contextTitle: (producer: string) => string
  cardTruncated: string
  retryIn: (seconds: number) => string
  retryFired: string
  retryWaiting: string
  retryFailureCode: string
  retryDelay: string
  goalActive: string
  goalPaused: string
  goalBlocked: (reason: string) => string
  goalComplete: string
  todoCounts: (active: number, pending: number, done: number) => string
  attachCount: (count: number) => string
  goalNone: string
  goalDetail: (revision: number, phase: string, rounds: number, max: number) => string
  goalObjective: string
  goalBlockedLine: (code: string, message: string) => string
  goalCreated: (created: string, updated: string) => string
  renameUsage: string
  renameDone: (title: string) => string
  workspaceUsage: string
  workspaceDone: (path: string) => string
  attachUsage: string
  attachDone: (path: string) => string
  forkUsage: string
  forkDone: string
  inputTooLarge: (bytes: number, max: number) => string
  busyEnterChanged: (next: string) => string
  thinkingChanged: (next: string) => string
  themeChanged: (next: string) => string
  localeChanged: (next: string) => string
  modelDefault: (model: string) => string
  effortDefault: (effort: string) => string
  credentialReadOnly: (ref: string) => string
  credentialWritten: (ref: string) => string
  credentialWriteFailed: (error: string) => string
  credentialRemoved: (ref: string) => string
  credentialRemoveFailed: (error: string) => string
  killJobRequested: (id: string) => string
  resumeDone: (id: string) => string
  presetSwitched: (id: string) => string
  invalidNumber: string
  fieldUpdated: (field: string) => string
  cancelRequested: string
  exitHint: string
  effortOff: string
  permissionChip: (label: string) => string
  permissionHint: string
  backToBottom: string
  pluginToggled: (id: string, enabled: boolean) => string
  tabSelectHint: string
}

/** The chrome copy table. */
const COPY: Record<Locale, Copy> = {
  zh: {
    idle: '▣ idle · Enter 发送 · /help',
    busyCancel: '· Esc 取消',
    queued: 'queued',
    historyPaused: 'history paused · PgDn 继续',
    plan: '◈ plan',
    planPending: '◈ plan…',
    placeholder: '输入任务，或输入 /help 查看命令…',
    credentialPlaceholder: '输入凭据新值（不回显）',
    secretPlaceholder: '输入新值（不回显）',
    numberPlaceholder: '输入数字，Enter 提交',
    stringPlaceholder: '输入新值，Enter 提交',
    paletteTitle: '╭─ 命令（↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 取消）',
    paletteHint: '╰─ ↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭',
    noMatch: '  No matching options',
    selAssistant: '· ↑↓ 选择 · g 赞 · b 踩',
    selCollapsible: '· ↑↓ 选择 · Space 展开/折叠',
    approval: '⚠ 请求工具执行许可：',
    allowOnce: '● Allow once（y）',
    deny: '○ Deny（n）',
    approvalHint: '↑↓ 选择 · Enter/y 允许 · n/Esc 拒绝',
    questionHint: '↑↓ 选择 · Enter 提交 · Esc 跳过（直接打字输入自定义答案）',
    questionInput: '输入回答，Enter 提交',
    goalDock: '◈ goal',
    todoDock: 'todo',
    queueDock: '⧗ 排队',
    thinking: 'Thinking',
    generating: 'Generating',
    callingTools: 'Calling tools',
    awaiting: 'Awaiting reply',
    turn: '轮',
    effort: 'effort',
    effortChanged: effort => `推理等级 → ${effort}`,
    effortUsage: '用法：/effort off|high|max',
    contextTitle: producer => `◆ 上下文注入 · ${producer}`,
    cardTruncated: '… 卡片过长，已截断显示',
    retryIn: seconds => `${seconds}s 后`,
    retryFired: '已触发',
    retryWaiting: '等待重试',
    retryFailureCode: '失败码',
    retryDelay: '延迟',
    goalActive: '进行中',
    goalPaused: '已暂停',
    goalBlocked: reason => `已阻塞：${reason}`,
    goalComplete: '已完成',
    todoCounts: (active, pending, done) => `${active} 进行中 · ${pending} 待办 · ${done} 已完成`,
    attachCount: count => `📎 ${count} 张图片附件随下一条消息发送`,
    goalNone: '当前会话没有 goal。用 /goal <目标> 创建一个。',
    goalDetail: (revision, phase, rounds, max) => `◈ goal rev ${revision} · ${phase} · round ${rounds}/${max}`,
    goalObjective: '目标：',
    goalBlockedLine: (code, message) => `阻塞原因 [${code}]：${message}`,
    goalCreated: (created, updated) => `创建 ${created} · 更新 ${updated}`,
    renameUsage: '用法：/rename <新标题>',
    renameDone: title => `会话标题 → ${title}`,
    workspaceUsage: '用法：/workspace <目录路径>',
    workspaceDone: path => `工作目录 → ${path}`,
    attachUsage: '用法：/attach <图片路径>（png/jpg/gif/webp）',
    attachDone: path => `已附加 ${path}（随下一条消息发送）`,
    forkUsage: '用法：/fork 或 /fork <eventSeq>',
    forkDone: '已分叉新会话（/sessions 可见，可恢复）',
    inputTooLarge: (bytes, max) => `输入过大：${bytes} bytes（上限 ${max}）`,
    busyEnterChanged: next => `busyEnter → ${next === 'steer' ? 'Steer 转向' : 'Queue 排队'}`,
    thinkingChanged: next => `thinking 默认显示 → ${next === 'expanded' ? '展开' : '折叠'}`,
    themeChanged: next => `theme → ${next === 'light' ? 'Light 浅色' : 'Dark 深色'}`,
    localeChanged: next => `locale → ${next === 'en' ? 'English' : '中文'}`,
    modelDefault: model => `默认模型 → ${model}`,
    effortDefault: effort => `推理等级 → ${effort}`,
    credentialReadOnly: ref => `${ref} 只读：被环境变量等来源遮蔽，无法写入`,
    credentialWritten: ref => `凭据 ${ref} 已写入（值不回显）`,
    credentialWriteFailed: error => `写入失败：${error}`,
    credentialRemoved: ref => `凭据 ${ref} 已移除`,
    credentialRemoveFailed: error => `移除失败：${error}`,
    killJobRequested: id => `已请求杀掉任务 ${id}`,
    resumeDone: id => `已恢复会话 ${id}`,
    presetSwitched: id => `已切换当前会话到预设 ${id}`,
    invalidNumber: '请输入有效的数字',
    fieldUpdated: field => `${field} 已更新`,
    cancelRequested: '已请求取消 · 2 秒内再按 Ctrl+C 退出',
    exitHint: '2 秒内再按 Ctrl+C 退出',
    effortOff: 'off',
    permissionChip: label => `权限 ${label}`,
    permissionHint: ' · Shift+Tab 切换',
    backToBottom: '▼ 回到底部',
    pluginToggled: (id, enabled) => `${id} → ${enabled ? '已开启' : '已关闭'}（已写入 cordis.patch.yml，HMR 即时生效）`,
    tabSelectHint: ' · Tab 选择消息 · Esc 返回',
  },
  en: {
    idle: '▣ idle · Enter send · /help',
    busyCancel: '· Esc cancel',
    queued: 'queued',
    historyPaused: 'history paused · PgDn resume',
    plan: '◈ plan',
    planPending: '◈ plan…',
    placeholder: 'Type a task, or /help for commands…',
    credentialPlaceholder: 'New credential value (not echoed)',
    secretPlaceholder: 'New value (not echoed)',
    numberPlaceholder: 'Enter a number, Enter to submit',
    stringPlaceholder: 'New value, Enter to submit',
    paletteTitle: '╭─ commands (↑↓ select · Enter run · Tab complete · Esc close)',
    paletteHint: '╰─ ↑↓ select · Enter run · Tab complete · Esc close',
    noMatch: '  No matching options',
    selAssistant: '· ↑↓ select · g like · b dislike',
    selCollapsible: '· ↑↓ select · Space expand/collapse',
    approval: '⚠ tool execution request: ',
    allowOnce: '● Allow once（y）',
    deny: '○ Deny（n）',
    approvalHint: '↑↓ select · Enter/y allow · n/Esc deny',
    questionHint: '↑↓ select · Enter submit · Esc skip (type for a custom answer)',
    questionInput: 'Type an answer, Enter to submit',
    goalDock: '◈ goal',
    todoDock: 'todo',
    queueDock: '⧗ queued',
    thinking: 'Thinking',
    generating: 'Generating',
    callingTools: 'Calling tools',
    awaiting: 'Awaiting reply',
    turn: 'turn',
    effort: 'effort',
    effortChanged: effort => `reasoning effort → ${effort}`,
    effortUsage: 'Usage: /effort off|high|max',
    contextTitle: producer => `◆ context injected · ${producer}`,
    cardTruncated: '… card too long, display truncated',
    retryIn: seconds => `in ${seconds}s`,
    retryFired: 'fired',
    retryWaiting: 'waiting',
    retryFailureCode: 'failure code',
    retryDelay: 'delay',
    goalActive: 'active',
    goalPaused: 'paused',
    goalBlocked: reason => `blocked: ${reason}`,
    goalComplete: 'complete',
    todoCounts: (active, pending, done) => `${active} in progress · ${pending} pending · ${done} done`,
    attachCount: count => `📎 ${count} image attachment${count === 1 ? '' : 's'} sent with the next message`,
    goalNone: 'This session has no goal. Create one with /goal <objective>.',
    goalDetail: (revision, phase, rounds, max) => `◈ goal rev ${revision} · ${phase} · round ${rounds}/${max}`,
    goalObjective: 'Objective: ',
    goalBlockedLine: (code, message) => `blocked reason [${code}]: ${message}`,
    goalCreated: (created, updated) => `created ${created} · updated ${updated}`,
    renameUsage: 'Usage: /rename <new title>',
    renameDone: title => `session title → ${title}`,
    workspaceUsage: 'Usage: /workspace <directory>',
    workspaceDone: path => `workspace → ${path}`,
    attachUsage: 'Usage: /attach <image path> (png/jpg/gif/webp)',
    attachDone: path => `attached ${path} (sent with the next message)`,
    forkUsage: 'Usage: /fork or /fork <eventSeq>',
    forkDone: 'Forked a new session (visible in /sessions, resumable)',
    inputTooLarge: (bytes, max) => `input too large: ${bytes} bytes (limit ${max})`,
    busyEnterChanged: next => `busyEnter → ${next === 'steer' ? 'steer' : 'queue'}`,
    thinkingChanged: next => `thinking default → ${next === 'expanded' ? 'expanded' : 'collapsed'}`,
    themeChanged: next => `theme → ${next === 'light' ? 'light' : 'dark'}`,
    localeChanged: next => `locale → ${next === 'en' ? 'English' : '中文'}`,
    modelDefault: model => `default model → ${model}`,
    effortDefault: effort => `reasoning effort → ${effort}`,
    credentialReadOnly: ref => `${ref} is read-only: shadowed by an env-var source, cannot write`,
    credentialWritten: ref => `credential ${ref} written (value not echoed)`,
    credentialWriteFailed: error => `write failed: ${error}`,
    credentialRemoved: ref => `credential ${ref} removed`,
    credentialRemoveFailed: error => `remove failed: ${error}`,
    killJobRequested: id => `kill requested for job ${id}`,
    resumeDone: id => `resumed session ${id}`,
    presetSwitched: id => `switched the current session to preset ${id}`,
    invalidNumber: 'Please enter a valid number',
    fieldUpdated: field => `${field} updated`,
    cancelRequested: 'cancel requested · press Ctrl+C again within 2s to exit',
    exitHint: 'press Ctrl+C again within 2s to exit',
    effortOff: 'off',
    permissionChip: label => `permission ${label}`,
    permissionHint: ' · Shift+Tab to switch',
    backToBottom: '▼ back to bottom',
    pluginToggled: (id, enabled) => `${id} → ${enabled ? 'enabled' : 'disabled'} (written to cordis.patch.yml, hot-applied)`,
    tabSelectHint: ' · Tab selects a message · Esc returns',
  },
}

/** Remap one Ink color intent for the light palette (dark is identity). */
function themed(color: string | undefined, theme: 'dark' | 'light', fallback: string): string {
  if (color === undefined || theme === 'dark') return color ?? fallback
  const LIGHT: Record<string, string> = {
    cyan: 'blue',
    magenta: 'magenta',
    yellow: 'yellow',
    green: 'green',
    red: 'red',
    blue: 'blue',
    gray: 'black',
    white: 'black',
  }
  return LIGHT[color] ?? color
}

/** Structured-trajectory palette: model blue, tool activity red, user cyan. */
export function traceLineColor(text: string): 'blue' | 'red' | 'cyan' | undefined {
  if (text.startsWith('· assistant')) return 'blue'
  if (text.startsWith('· tool ') || text.startsWith('· result ')) return 'red'
  if (text.startsWith('· user')) return 'cyan'
  return undefined
}

/** Half-width of the highlight window in cells (a 9-cell soft band). */
const SHIMMER_WINDOW = 4

/**
 * One character's grayscale level under the sweeping highlight. The window
 * (medium gray → lighter → near-white → lighter → medium gray, smoothstep
 * falloff) travels left to right across the label and loops. The base stays
 * clearly readable but visibly dimmer than normal assistant output. Pure:
 * the renderer stamps one phase per tick (~100ms).
 * @param index - the character index inside the label.
 * @param phase - the animation phase (increments once per tick).
 * @param length - the label length the window sweeps across.
 * @returns the grayscale level, 0-255.
 */
export function thinkingShimmerLevel(index: number, phase: number, length: number): number {
  const span = length + SHIMMER_WINDOW * 2 + 1
  const center = (phase % span) - SHIMMER_WINDOW
  const t = Math.max(0, Math.min(1, 1 - Math.abs(index - center) / (SHIMMER_WINDOW + 1)))
  const smooth = t * t * (3 - 2 * t)
  return Math.round(145 + 110 * smooth)
}

/**
 * One grayscale level as a TrueColor hex (chalk downlevels it to ANSI-256
 * automatically on terminals without 24-bit support).
 * @param level - the grayscale level, 0-255.
 * @returns the `#rrggbb` color.
 */
export function thinkingShimmerHex(level: number): string {
  const value = Math.max(0, Math.min(255, level)).toString(16).padStart(2, '0')
  return `#${value}${value}${value}`
}

/**
 * The brand glyph leading the header title. The whale emoji needs a
 * width-correct terminal (modern terminals measure it as two cells); on
 * legacy environments that mishandle emoji width it degrades to a narrow
 * glyph so the row alignment never breaks.
 * @param env - the environment mapping.
 * @returns the glyph.
 */
export function brandGlyph(env: Record<string, string | undefined>): string {
  if (env.TERM === 'dumb') return '✦'
  if (env.TERM_PROGRAM === 'Apple_Terminal') return '✦'
  const modern = env.WT_SESSION !== undefined
    || env.ConEmuANSI !== undefined
    || env.TERM_PROGRAM !== undefined
    || env.TERM?.startsWith('xterm') === true
    || env.TERM?.includes('256color') === true
    || env.COLORTERM !== undefined
  // Legacy Windows conhost (no modern-terminal marker) measures emoji
  // inconsistently.
  if (process.platform === 'win32' && !modern) return '✦'
  return '🐋'
}

/**
 * Set the terminal tab/window title through the standard OSC sequence. The
 * previous title is queried first (`ESC[21t`); the report arrives on stdin
 * and is captured for restore on exit. Terminals without title support
 * ignore the writes silently.
 */
function installTerminalTitle(stdout: { write(chunk: string): unknown }, report: { current: string }): () => void {
  stdout.write('\x1b[21t')
  stdout.write('\x1b]0;🐋 DeepSeek Harness\x07')
  return () => {
    if (report.current !== '') stdout.write(`\x1b]0;${report.current}\x07`)
  }
}
/** Host callbacks the renderer drives; supplied by the plugin. */
export interface TuiHost {
  submit(text: string, steer: boolean): void
  cancel(): void
  exit(): void
  newSession(): void
  selectModel(provider: string, model: string, reasoningEffort?: string): void
  /** `/effort off|high|max`: set or clear the reasoning effort on the current route. */
  setEffort(effort: string | undefined): void
  /** Shift+Tab: rotate the session's file-policy mode; returns the new mode. */
  cycleSandbox(): 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Toggle one plugin entry in the profile's user patch layer (hot-applied). */
  togglePlugin(id: string): Promise<{ error: string } | { enabled: boolean }>
  approve(outcome: 'allowed-once' | 'rejected'): void
  answerQuestion(answers: { id: string; selected: string[]; custom?: string }[]): void
  /** Write one `tui` namespace setting (busyEnter / thinking / theme / locale). */
  updateSetting(patch: { busyEnter?: 'queue' | 'steer'; thinking?: 'collapsed' | 'expanded'; theme?: 'dark' | 'light'; locale?: 'zh' | 'en' }): Promise<void>
  /** Durably store one credential; the renderer never sees the previous value. */
  setCredential(ref: string, value: string): Promise<void>
  /** Remove one credential from the managed store. */
  unsetCredential(ref: string): Promise<void>
  /** Reload the live /jobs and /subagents panel rows (panel open / poll). */
  refreshPanels(): void
  /** Reload the /settings page data (settings panel open). */
  refreshSettings(): void
  /** Request one running job to stop. */
  killJob(id: string): void
  /** Create/replace/remove feedback for one assistant message (toggle on re-rate). */
  rateMessage(messageId: string, rating: 'positive' | 'negative'): Promise<string | null>
  /** Resume one persisted session onto the surface (null on success). */
  resumeSession(sessionId: string): Promise<string | null>
  /** Switch onto a NEW session composed from one agent preset (null on success). */
  switchPreset(presetId: string): Promise<string | null>
  /** Write one field of a plugin's settings namespace (null on success). */
  updatePluginConfig(ns: string, patch: Record<string, unknown>): Promise<string | null>
  /** Rename the live session (explicit user title). */
  renameSession(title: string): Promise<string | null>
  /** Switch the workspace directory for this and future sessions. */
  changeWorkspace(path: string): Promise<string | null>
  /** Attach one image file to the next user message. */
  attachFile(path: string): Promise<string | null>
  /** Fork the session at the last completed turn (or the turn containing atSeq). */
  forkSession(atSeq?: number): Promise<string | null>
  /** Boot-time panel request: open this panel (with an optional filter) once the app mounts. */
  startup?: { panel?: { kind: PanelKind; filter?: string } }
}

/**
 * Chinese descriptions for the host slash commands (their packages publish
 * English-only descriptions); display-layer only — execution is untouched.
 */
const HOST_COMMAND_ZH: Record<string, string> = {
  goal: '设置或查看长期任务的 goal',
  plan: '进入或退出 plan 模式',
  compact: '压缩较早的对话历史',
  feedback: '记录对本次会话的反馈',
  permission: '设置命令权限预设',
  export: '下载本会话日志（ZIP 归档）',
}

/** The `dsh` slash catalog: host commands plus TUI-local commands. */
function localCommands(locale: Locale): { name: string; description: string; needsArgs: boolean }[] {
  const zh = locale === 'zh'
  return [
    { name: 'help', description: zh ? '显示帮助' : 'show this help', needsArgs: false },
    { name: 'clear', description: zh ? '清空显示（保留会话）' : 'clear the display (session kept)', needsArgs: false },
    { name: 'trajectory', description: zh ? '切换结构化轨迹视图' : 'toggle the structured trajectory view', needsArgs: false },
    { name: 'model', description: zh ? '选择模型' : 'pick a model', needsArgs: false },
    { name: 'settings', description: zh ? '设置五页（general/models/plugins/inventory/presets）' : 'five pages: general/models/plugins/inventory/presets', needsArgs: false },
    { name: 'jobs', description: zh ? '后台任务面板（Enter 杀掉选中任务）' : 'background jobs panel (Enter kills the selected job)', needsArgs: false },
    { name: 'subagents', description: zh ? '子代理树面板' : 'subagent tree panel', needsArgs: false },
    { name: 'workflows', description: zh ? 'workflow 运行进度面板' : 'workflow run progress panel', needsArgs: false },
    { name: 'sessions', description: zh ? '列出活动会话' : 'list live sessions', needsArgs: false },
    { name: 'presets', description: zh ? '切换 agent 预设（设置页）' : 'switch the agent preset (settings page)', needsArgs: false },
    { name: 'effort', description: zh ? '设置推理力度（off/high/max）' : 'set the reasoning effort (off/high/max)', needsArgs: true },
    { name: 'goal', description: zh ? '查看当前 goal 详情' : 'current goal details', needsArgs: false },
    { name: 'rename', description: zh ? '重命名当前会话标题' : 'rename the current session title', needsArgs: true },
    { name: 'workspace', description: zh ? '切换工作目录' : 'switch the workspace directory', needsArgs: true },
    { name: 'attach', description: zh ? '附加图片到下一消息（png/jpg/gif/webp）' : 'attach an image to the next message (png/jpg/gif/webp)', needsArgs: true },
    { name: 'fork', description: zh ? '在最后完成回合处分叉会话' : 'fork the session at the last completed turn', needsArgs: false },
    { name: 'new', description: zh ? '开始新会话' : 'start a new session', needsArgs: false },
    { name: 'quit', description: zh ? '保存并退出' : 'save and exit', needsArgs: false },
    { name: 'exit', description: zh ? '保存并退出' : 'save and exit', needsArgs: false },
  ]
}

/** Keep the tail of one line within a display width (DamnatioX `shorten`). */
function shorten(value: string, width: number): string {
  const safe = sanitizeTerminalText(value)
  if (width < 2 || stringWidth(safe) <= width) return safe
  // Cut from the FRONT by display cells: a code-unit slice would let
  // double-width CJK glyphs overshoot the budget.
  let used = 0
  const characters = [...safe]
  let start = 0
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const next = Math.max(1, stringWidth(characters[index] ?? ''))
    if (used + next > width - 1) break
    used += next
    start = index
  }
  return `…${characters.slice(start).join('')}`
}

/** Hard-wrap one source line by terminal cell width. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  for (const source of text.split('\n')) {
    if (source === '') {
      lines.push('')
      continue
    }
    let current = ''
    let currentWidth = 0
    for (const character of source) {
      const characterWidth = Math.max(1, stringWidth(character))
      if (currentWidth + characterWidth > width) {
        lines.push(current)
        current = ''
        currentWidth = 0
      }
      current += character
      currentWidth += characterWidth
    }
    lines.push(current)
  }
  return lines
}

/** Word-aware hard wrap for prose: breaks on spaces, only over-long words break by cells. */
function wrapTextWords(text: string, width: number): string[] {
  const lines: string[] = []
  for (const source of text.split('\n')) {
    const words = source.split(/\s+/).filter(word => word !== '')
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let current = ''
    let currentWidth = 0
    for (const word of words) {
      const wordWidth = stringWidth(word)
      if (current === '') {
        if (wordWidth > width) {
          lines.push(...wrapText(word, width))
          continue
        }
        current = word
        currentWidth = wordWidth
        continue
      }
      if (currentWidth + 1 + wordWidth <= width) {
        current += ` ${word}`
        currentWidth += 1 + wordWidth
      } else {
        lines.push(current)
        current = ''
        currentWidth = 0
        if (wordWidth > width) lines.push(...wrapText(word, width))
        else {
          current = word
          currentWidth = wordWidth
        }
      }
    }
    if (current !== '') lines.push(current)
  }
  return lines
}

/** Collapsible node kinds: they render a title line plus an optional body. */
function isCollapsible(node: TuiNode): boolean {
  return node.kind === 'context' || node.kind === 'think' || node.kind === 'tool' || node.kind === 'retry'
}

/** Project one node into wrapped, colored lines, honoring expand state. */
function nodeLines(
  node: TuiNode,
  width: number,
  expanded: boolean,
  selected: boolean,
  retryShimmer: boolean,
  feedback: ReadonlyMap<string, { rating: 'positive' | 'negative' }> | undefined,
  locale: Locale,
): TranscriptLine[] {
  const copy = COPY[locale]
  const marker = selected ? '» ' : ''
  const withKey = (lines: { text: string; color?: string; dim?: boolean; runs?: MdRun[] }[]): TranscriptLine[] =>
    lines.map((line, index) => ({
      key: `${node.id}-${index}`,
      ...line,
      ...(line.runs !== undefined ? { runs: line.runs } : {}),
      dim: line.dim === true,
    }))
  switch (node.kind) {
    case 'user':
      return withKey(wrapText(`${marker}▸ ${sanitizeTerminalText(node.text)}`, width).map(text => ({ text, color: 'cyan' })))
    case 'context': {
      const title = expanded
        ? `${copy.contextTitle(node.producer)} ▼`
        : `${copy.contextTitle(node.producer)} ▶`
      const head = wrapText(marker + title, width).map(text => ({
        text, color: 'gray',
      }))
      const body = expanded
        ? wrapText(sanitizeTerminalText(node.text), width - 2).map(text => ({ text: `  ${text}`, dim: true }))
        : []
      return withKey([...head, ...body])
    }
    case 'assistant': {
      if (node.text === '') return []
      const rating = feedback?.get(node.messageId)?.rating
      const ratingGlyph = rating === 'positive' ? '👍 ' : rating === 'negative' ? '👎 ' : ''
      const lines: { text: string; color?: string; runs?: MdRun[] }[] = []
      let first = true
      for (const md of markdownLines(sanitizeTerminalText(node.text), width)) {
        const prefix = first && md.text !== '' ? `${marker}${ratingGlyph}● ` : ''
        first = md.text === '' ? first : false
        if (md.runs !== undefined) {
          for (const wrapped of wrapRuns(md.runs, width, prefix)) {
            lines.push({
              text: wrapped.text,
              runs: wrapped.runs,
              ...(md.color !== undefined ? { color: md.color } : {}),
            })
          }
        } else {
          for (const text of wrapText(`${prefix}${md.text}`, width)) {
            lines.push({ text, ...(md.color !== undefined ? { color: md.color } : {}) })
          }
        }
      }
      return withKey(lines.filter(line => line.text !== '' || (line.runs?.length ?? 0) > 0))
    }
    case 'think': {
      const durationLabel = `${(node.durationMs / 1000).toFixed(1)}s`
      const head = wrapText(marker + (expanded ? `✓ Thinking ${durationLabel} ▼` : `✓ Thinking ${durationLabel} ▶`), width).map(text => ({
        text, color: 'magenta', dim: !expanded,
      }))
      // The `  │ ` prefix consumes 4 cells and is added AFTER wrapping, so
      // the wrap budget must reserve those 4 cells: wrapping the raw text at
      // width - 2 made each budget-filling segment 2 cells wider than the
      // content area, and Ink's wrap machinery split the row right after the
      // prefix — the vertical bar ended up alone on its row while the text
      // moved to a bare row below it. With the prefix inside the budget,
      // every body row keeps its own bar and never overflows.
      const body = expanded
        ? wrapTextWords(sanitizeTerminalText(node.text), width - 4).map(text => ({ text: `  │ ${text}`, color: 'magenta', dim: true }))
        : []
      return withKey([...head, ...body])
    }
    case 'tool': {
      const glyph = node.status === 'running' ? '○' : '◇'
      const title = `${glyph} ${sanitizeTerminalText(node.detail)}${node.status === 'running' ? ' …' : ` · ${node.status}`}`
      const head = wrapText(marker + title, width).map(text => ({
        text,
        color: node.status === 'error' ? 'red' : node.status === 'running' ? 'yellow' : 'green',
      }))
      if (!expanded) return withKey(head)
      const card = node.status === 'running'
        ? projectCallCard(node.callCard as never, node.detail)
        : projectResultCard(node.resultCard as never, node.text)
      const body: { text: string; color?: string; dim?: boolean }[] = []
      let bodyRows = 0
      for (const line of card) {
        if (bodyRows >= MAX_TOOL_CARD_ROWS) break
        for (const text of wrapText(`  ${sanitizeTerminalText(line.text)}`, width - 2)) {
          if (bodyRows >= MAX_TOOL_CARD_ROWS) break
          body.push({
            text,
            ...(line.color !== undefined ? { color: line.color } : {}),
            dim: line.color === undefined || line.color === 'gray',
          })
          bodyRows += 1
        }
      }
      if (bodyRows >= MAX_TOOL_CARD_ROWS) {
        body.push({ text: `  ${copy.cardTruncated}`, dim: true })
      }
      return withKey([...head, ...body])
    }
    case 'retry': {
      const maxLabel = node.maxRetries === null ? '∞' : String(node.maxRetries)
      const remaining = retryCountdownSeconds(node.retryAt, Date.now())
      const waiting = !node.started && remaining !== null
      const title = waiting
        ? `⟳ retry ${node.retry}/${maxLabel} · ${copy.retryIn(remaining)}`
        : `⟳ retry ${node.retry}/${maxLabel} · ${node.started ? copy.retryFired : copy.retryWaiting}`
      const head = wrapText(marker + title, width).map(text => ({
        text, color: 'gray', dim: waiting ? retryShimmer : !expanded,
      }))
      const body = expanded
        ? wrapText(
          `  │ ${node.provider} · ${node.policyKey} · ${copy.retryFailureCode} ${node.failure.code}${node.failure.status !== undefined ? ` · HTTP ${node.failure.status}` : ''}${node.delayMs > 0 ? ` · ${copy.retryDelay} ${Math.max(0, Math.round(node.delayMs))}ms` : ''}`,
          width - 2,
        ).map(text => ({ text, dim: true }))
        : []
      return withKey([...head, ...body])
    }
    case 'status':
      return withKey(wrapText(`${marker}${node.error ? '×' : '◆'} ${sanitizeTerminalText(node.text)}`, width).map(text => ({
        text, color: node.error ? 'red' : 'gray',
      })))
  }
}

/** Three-row compact header plus a separator (DamnatioX header geometry). */
function Header(props: {
  snapshot: ReturnType<TuiStore['getSnapshot']>
  width: number
  theme: 'dark' | 'light'
}): React.ReactElement {
  const snapshot = props.snapshot
  const thinking = snapshot.settings?.general.thinking === 'expanded' ? 'on' : 'off'
  const busyEnter = snapshot.settings?.general.busyEnter ?? 'queue'
  const brand = `${brandGlyph(process.env)} DSH-TUI`
  // Both sides budget against the PHYSICAL width: an overflowing side would
  // wrap onto the next row and corrupt the frame on narrow windows.
  const sessionRight = `session ${snapshot.sessionId}`
  const rows: { left: { text: string; color?: string; bold?: boolean }; right: string }[] = [
    {
      left: { text: brand, color: 'cyan', bold: true },
      right: fitDisplayText(sessionRight, Math.max(6, props.width - stringWidth(brand) - 2)),
    },
    {
      left: { text: shorten(snapshot.cwd, Math.max(4, props.width - stringWidth(`thinking ${thinking}`) - 2)) },
      right: `thinking ${thinking}`,
    },
    {
      left: { text: shorten(`${snapshot.model} · busyEnter ${busyEnter}`, Math.max(4, props.width - stringWidth(`${snapshot.nodes.length} events`) - 2)), color: 'magenta' },
      right: `${snapshot.nodes.length} events`,
    },
  ]
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => {
        const pad = Math.max(1, props.width - stringWidth(row.left.text) - stringWidth(row.right))
        return (
          <Text key={index}>
            <Text color={themed(row.left.color, props.theme, 'white')} bold={row.left.bold === true}>
              {row.left.text}
            </Text>
            <Text dimColor>{' '.repeat(pad)}{row.right}</Text>
          </Text>
        )
      })}
      <Text dimColor>{'─'.repeat(Math.max(1, props.width))}</Text>
    </Box>
  )
}

/** The transcript viewport with the browser-style right-edge scrollbar column and the floating back-to-bottom button. */
function Transcript(props: {
  lines: readonly TranscriptLine[]
  height: number
  width: number
  offset: number
  onMaximumOffsetChange?: (maximumOffset: number, lineCount: number) => void
  theme: 'dark' | 'light'
  locale: Locale
  /** Pin the floating back-to-bottom button when scrolled off the tail. */
  backButton?: boolean
}): React.ReactElement {
  const viewport = selectTranscriptViewport([...props.lines], props.height, props.offset, props.backButton === true ? 1 : 0)
  const scrollbar = selectScrollbar(props.lines.length, props.height, viewport.offset, props.backButton === true ? 1 : 0)
  useEffect(() => {
    props.onMaximumOffsetChange?.(viewport.maximumOffset, props.lines.length)
  }, [props.onMaximumOffsetChange, viewport.maximumOffset, props.lines.length])
  // The scrollbar lives in its OWN right-edge column (a browser-style strip,
  // never characters appended to content rows): content and gutter render as
  // sibling Boxes, so no line's text width can ever shift, wrap, or break the
  // rail — the gutter stays a perfectly straight line on the last column, and
  // the thumb sits at a stable, clickable position.
  return (
    <Box flexDirection="row" flexGrow={1} height={Math.max(1, props.height)} overflow="hidden">
      <Box
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        paddingX={1}
        justifyContent="flex-end"
      >
        {viewport.lines.map((line, index) => (
          // Index keys: scrolling reorders the visible rows every wheel tick,
          // and keyed reordering through Ink's reconciler can accumulate stale
          // rows — position-keyed rows never move, only their text changes.
          <Text key={index} color={themed(line.color, props.theme, 'white')} bold={line.bold === true} dimColor={line.dim === true}>
            {line.runs !== undefined && line.runs.length > 0
              ? line.runs.map((run, runIndex) => (
                <Text key={runIndex} bold={run.bold === true} underline={run.underline === true} dimColor={run.dim === true}
                  {...run.color !== undefined
                    ? { color: themed(run.color, props.theme, 'white') }
                    : run.code === true
                      ? { color: themed('cyan', props.theme, 'cyan') }
                      : {}}>
                  {run.text}
                </Text>
              ))
              : (line.text || ' ')}
          </Text>
        ))}
        {props.backButton === true ? (
          <Text key="back-button">
            {' '.repeat(Math.max(0, Math.floor((Math.max(1, props.width - 3) - stringWidth(` ${COPY[props.locale].backToBottom} `)) / 2)))}
            <Text bold inverse color={themed('cyan', props.theme, 'cyan')}>{` ${COPY[props.locale].backToBottom} `}</Text>
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" width={1} overflow="hidden">
        {scrollbar.visible
          ? Array.from({ length: Math.max(1, props.height) }, (_, index) => {
            const thumb = index >= scrollbar.thumbTop && index < scrollbar.thumbTop + scrollbar.thumbHeight
            return (
              <Text key={index} bold={thumb} dimColor={!thumb} {...(thumb ? { color: themed('cyan', props.theme, 'cyan') } : {})}>
                {thumb ? '█' : '│'}
              </Text>
            )
          })
          : null}
      </Box>
    </Box>
  )
}

/** One full-screen panel row list (settings/jobs/subagents/workflows). */
function PanelView(props: {
  rows: readonly PanelRow[]
  height: number
  offset: number
  selectedIndex: number
  theme: 'dark' | 'light'
}): React.ReactElement {
  const lines: TranscriptLine[] = props.rows.map((row, index) => ({
    key: row.key,
    text: `${index === props.selectedIndex ? '▸ ' : '  '}${row.text}`,
    ...(index === props.selectedIndex ? { color: 'yellow' } : row.color !== undefined ? { color: row.color } : {}),
    bold: index === props.selectedIndex,
    dim: row.dim === true && index !== props.selectedIndex,
  }))
  const viewport = selectPanelViewport(lines, props.height, props.offset)
  return (
    <Box flexDirection="column" flexGrow={1} height={Math.max(1, props.height)} overflow="hidden" paddingX={1}>
      {viewport.lines.map((line, index) => (
        <Text key={index} wrap="truncate" color={themed(line.color, props.theme, 'white')} bold={line.bold === true} dimColor={line.dim === true}>
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

/** The slash picker between transcript and composer (DamnatioX palette style). */
function CommandPaletteView(props: {
  matches: readonly { name: string; description: string }[]
  selectedIndex: number
  width: number
  height: number
  locale: Locale
}): React.ReactElement {
  const paletteWidth = Math.max(1, Math.floor(props.width))
  const contentWidth = Math.max(1, paletteWidth - 2)
  const items = props.matches
  const copy = COPY[props.locale]
  // The budgeted height owns the rendered rows: title + hint take two, the
  // rest list items — never more, or the rows below get overwritten.
  const itemCapacity = Math.max(0, props.height - 2)
  const start = Math.max(0, Math.min(props.selectedIndex - (itemCapacity - 1), Math.max(0, items.length - itemCapacity)))
  const visibleItems = items.slice(start, start + itemCapacity)
  return (
    <Box flexDirection="column" paddingX={paletteWidth > 2 ? 1 : 0} width={paletteWidth} height={Math.max(1, props.height)} overflow="hidden">
      <Text bold color="cyan" wrap="truncate">{shorten(copy.paletteTitle, contentWidth)}</Text>
      {visibleItems.length === 0
        ? <Text dimColor>{copy.noMatch}</Text>
        : visibleItems.map((command, index) => {
          const absoluteIndex = start + index
          const label = `/${command.name}`
          const description = fitDisplayText(sanitizeTerminalText(command.description), Math.max(1, contentWidth - stringWidth(label) - 4))
          return (
            <Text
              key={command.name}
              color={absoluteIndex === props.selectedIndex ? 'cyan' : 'white'}
              bold={absoluteIndex === props.selectedIndex}
              inverse={absoluteIndex === props.selectedIndex}
            >
              {fitDisplayText(`${absoluteIndex === props.selectedIndex ? '▸' : ' '} ${label}  ${description}`, contentWidth)}
            </Text>
          )
        })}
      <Text dimColor wrap="truncate">{shorten(copy.paletteHint, contentWidth)}</Text>
    </Box>
  )
}

/** Keep the head of one line within a display width (trailing ellipsis). */
function fitDisplayText(value: string, width: number): string {
  const safe = sanitizeTerminalText(value)
  if (width < 2 || stringWidth(safe) <= width) return safe
  return `${safe.slice(0, width - 1)}…`
}

/** Cap on composer lines: overflowing text wraps, never steals the frame. */
const MAX_COMPOSER_LINES = 5

/** Multi-line caret-anchored input: overflowing text wraps onto further lines. */
function ImeTextInput(props: {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string, steer?: boolean) => void
  placeholder: string
  focus: boolean
  width: number
  mask?: string
  /** Inputs the App handles itself (selection keys) must never reach the draft. */
  reserveKeys?: (input: string) => boolean
}): React.ReactElement {
  const [cursorOffset, setCursorOffset] = useState(props.value.length)
  const cursorOffsetRef = useRef(props.value.length)
  const latestValueRef = useRef(props.value)
  const pendingLocalValues = useRef(new Set<string>())
  const inputRef = useRef<DOMElement | null>(null)
  const [origin, setOrigin] = useState({ x: 0, y: 0, measured: false })

  useEffect(() => {
    if (pendingLocalValues.current.delete(props.value)) {
      if (latestValueRef.current === props.value) {
        pendingLocalValues.current.clear()
        const nextOffset = Math.min(cursorOffsetRef.current, props.value.length)
        cursorOffsetRef.current = nextOffset
        setCursorOffset(nextOffset)
      }
      return
    }
    pendingLocalValues.current.clear()
    latestValueRef.current = props.value
    cursorOffsetRef.current = props.value.length
    setCursorOffset(props.value.length)
  }, [props.value])

  const displayValue = props.mask ? props.mask.repeat([...props.value].length) : props.value
  const displayCursorOffset = props.mask
    ? props.mask.length * [...props.value.slice(0, cursorOffset)].length
    : cursorOffset
  const layout = selectComposerLayout(displayValue, displayCursorOffset, props.width, MAX_COMPOSER_LINES)
  useLayoutEffect(() => {
    if (inputRef.current === null) return
    const metrics = measureElement(inputRef.current)
    setOrigin(current =>
      current.measured && current.x === metrics.x && current.y === metrics.y
        ? current
        : { x: metrics.x, y: metrics.y, measured: true })
  })
  const moveCursor = useCallback((nextOffset: number) => {
    cursorOffsetRef.current = nextOffset
    setCursorOffset(nextOffset)
  }, [])

  const commitEdit = useCallback(
    (nextValue: string, nextOffset: number) => {
      latestValueRef.current = nextValue
      pendingLocalValues.current.add(nextValue)
      moveCursor(nextOffset)
      props.onChange(nextValue)
    },
    [moveCursor, props.onChange],
  )

  useInput(
    (input, key) => {
      // A bare CSI tail inside a pending-Escape window is the second half of
      // a split arrow sequence, not text: swallow it (App re-synthesizes the
      // key) so it can never pollute the draft.
      if (escapeArbiter.hasPending() && csiTailKey(input) !== null) return
      // A terminal title report (OSC answer to the title query) is metadata,
      // never draft content — swallow both whole and split forms.
      if (input.startsWith(']l') || input.startsWith('\x1b]l')) return
      if (props.reserveKeys?.(input) === true) return
      if (
        key.upArrow ||
        key.downArrow ||
        key.tab ||
        (key.shift && key.tab) ||
        input === '\x1b[Z' ||
        (key.ctrl && input.toLowerCase() === 'c')
      ) {
        return
      }
      if (key.return) {
        if (key.shift === true) {
          // Shift+Enter inserts a real newline (the composer wraps it).
          const currentValue = latestValueRef.current
          const currentOffset = cursorOffsetRef.current
          const next = `${currentValue.slice(0, currentOffset)}\n${currentValue.slice(currentOffset)}`
          commitEdit(next, currentOffset + 1)
          return
        }
        props.onSubmit(latestValueRef.current, key.ctrl === true)
        return
      }
      if (key.leftArrow) {
        const currentValue = latestValueRef.current
        moveCursor(previousCodePointBoundary(currentValue, cursorOffsetRef.current))
        return
      }
      if (key.rightArrow) {
        const currentValue = latestValueRef.current
        moveCursor(nextCodePointBoundary(currentValue, cursorOffsetRef.current))
        return
      }
      if (key.home || (key.ctrl && input.toLowerCase() === 'a')) {
        moveCursor(0)
        return
      }
      if (key.end || (key.ctrl && input.toLowerCase() === 'e')) {
        moveCursor(latestValueRef.current.length)
        return
      }
      if (key.backspace || key.delete) {
        const currentValue = latestValueRef.current
        const currentOffset = cursorOffsetRef.current
        const start = previousCodePointBoundary(currentValue, currentOffset)
        if (start !== currentOffset) {
          const next = `${currentValue.slice(0, start)}${currentValue.slice(currentOffset)}`
          commitEdit(next, start)
        }
        return
      }
      const safeInput = sanitizeTerminalText(stripMouseReports(input))
      if (!safeInput) return
      const currentValue = latestValueRef.current
      const currentOffset = cursorOffsetRef.current
      const next = `${currentValue.slice(0, currentOffset)}${safeInput}${currentValue.slice(currentOffset)}`
      commitEdit(next, currentOffset + safeInput.length)
    },
    { isActive: props.focus },
  )
  usePaste(
    (pasted: string) => {
      const safePaste = sanitizeTerminalText(stripMouseReports(pasted))
      if (!props.focus || !safePaste) return
      const currentValue = latestValueRef.current
      const currentOffset = cursorOffsetRef.current
      const next = `${currentValue.slice(0, currentOffset)}${safePaste}${currentValue.slice(currentOffset)}`
      commitEdit(next, currentOffset + safePaste.length)
    },
    { isActive: props.focus },
  )

  return (
    <Box ref={inputRef} width={Math.max(1, Math.floor(props.width))} flexDirection="column" overflow="hidden">
      {props.focus && origin.measured ? (
        <NativeCursor
          x={origin.x + layout.caretColumn}
          y={origin.y + layout.caretLine}
        />
      ) : null}
      {props.value === ''
        ? (props.focus
        // Focused + empty keeps the row via a non-breaking space: the
        // placeholder hides so the IME pre-edit popup never collides
        // with it, and Ink drops whitespace-only Text content.
          ? <Text wrap="truncate">{'\u00a0'}</Text>
          : <Text dimColor wrap="truncate">{props.placeholder}</Text>)
        : layout.visibleLines.map((line, index) => (
          <Text key={index} wrap="truncate">{line === '' ? ' ' : line}</Text>
        ))}
    </Box>
  )
}

/** Anchor the native cursor through Ink's own output (IME composition). */
function NativeCursor({ x, y }: { x: number; y: number }): null {
  const { setCursorPosition } = useCursor()
  // measureElement() and Ink's cursor API share zero-based live-layout rows,
  // but a fullscreen frame writes NO trailing newline: after the write the
  // terminal cursor rests ON the last line, while Ink's cursor suffix counts
  // from one line below it (`moveUp = visibleLineCount - y`). The +1
  // compensates that off-by-one so the caret lands on the input row instead
  // of the row above it.
  setCursorPosition({ x, y: y + 1 })
  return null
}

/** The composer: a separator, the `› ` prompt, and the wrapping input. */
function Composer(props: {
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: (value: string, steer?: boolean) => void
  disabled: boolean
  focused: boolean
  width: number
  placeholder: string
  reserveKeys?: (input: string) => boolean
  mask?: string
  theme: 'dark' | 'light'
}): React.ReactElement {
  const safeValue = sanitizeTerminalText(props.draft)
  const inputWidth = Math.max(1, props.width - 4)
  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(Math.max(1, props.width))}</Text>
      <Box paddingX={1}>
        <Box flexDirection="row">
          <Text bold color={themed(props.disabled ? 'gray' : 'cyan', props.theme, 'cyan')}>{'› '}</Text>
          <Box flexGrow={1} flexDirection="column">
            {props.disabled
              ? (
                <DisabledComposerLines value={safeValue} placeholder={props.placeholder} width={inputWidth} />
              )
              : (
                <ImeTextInput
                  value={safeValue}
                  onChange={next => props.onDraftChange(sanitizeTerminalText(stripMouseReports(next)))}
                  onSubmit={props.onSubmit}
                  placeholder={props.placeholder}
                  focus={props.focused}
                  width={inputWidth}
                  {...(props.reserveKeys !== undefined ? { reserveKeys: props.reserveKeys } : {})}
                  {...(props.mask !== undefined ? { mask: props.mask } : {})}
                />
              )}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

/** The wrapped read-only draft shown while the composer is disabled. */
function DisabledComposerLines(props: { value: string; placeholder: string; width: number }): React.ReactElement {
  const layout = selectComposerLayout(props.value, props.value.length, props.width, MAX_COMPOSER_LINES)
  if (props.value === '') return <Text dimColor wrap="truncate">{props.placeholder}</Text>
  return (
    <>
      {layout.visibleLines.map((line, index) => (
        <Text key={index} dimColor wrap="truncate">{line === '' ? ' ' : line}</Text>
      ))}
    </>
  )
}

/** Display label for one file-policy mode (the Web permission wording). */
export function permissionLabel(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): string {
  return mode === 'read-only'
    ? 'read only'
    : mode === 'workspace-write'
      ? 'workspace write'
      : 'full access'
}

/** Status-bar color for one file-policy mode: bright white / yellow / red. */
export function permissionColor(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): 'whiteBright' | 'yellowBright' | 'redBright' {
  return mode === 'read-only' ? 'whiteBright' : mode === 'workspace-write' ? 'yellowBright' : 'redBright'
}

/** The status bar: separator, activity row, and the Web-stats strip. */
function StatusBar(props: {
  snapshot: ReturnType<TuiStore['getSnapshot']>
  width: number
  panelOpen: boolean
  scrollOffset: number
  selectionHint?: string
  locale: Locale
  theme: 'dark' | 'light'
}): React.ReactElement {
  const snapshot = props.snapshot
  const copy = COPY[props.locale]
  const phaseLabel = (snapshot.live?.think ?? '') !== ''
    ? copy.thinking
    : (snapshot.live?.text ?? '') !== ''
      ? copy.generating
      : snapshot.nodes.some(node => node.kind === 'tool' && node.status === 'running')
        ? copy.callingTools
        : copy.awaiting
  const elapsedLabel = snapshot.live?.thinkSince !== null && snapshot.live?.thinkSince !== undefined
    ? ` · ${((Date.now() - snapshot.live.thinkSince) / 1000).toFixed(1)}s`
    : ''
  const queuedLabel = snapshot.queued.length > 0 ? ` · ${copy.queued} ${snapshot.queued.length}` : ''
  const historyPaused = !props.panelOpen && props.scrollOffset > 0 ? ` · ${copy.historyPaused}` : ''
  const planLabel = snapshot.plan.active ? ` · ${copy.plan}` : snapshot.plan.pending ? ` · ${copy.planPending}` : ''
  const left = snapshot.busy
    ? `● ${phaseLabel}${elapsedLabel}${queuedLabel}${planLabel} ${copy.busyCancel}`
    : `${copy.idle}${historyPaused}${planLabel}${props.selectionHint ?? copy.tabSelectHint}`
  const effortLabel = snapshot.reasoning.effort ?? copy.effortOff
  const effortText = `${copy.effort} ${effortLabel}`
  const rightRest = ` · ${copy.turn} ${snapshot.stats.turns} · ↑${snapshot.stats.tokens.input} ↓${snapshot.stats.tokens.output} Σ${snapshot.stats.tokens.input + snapshot.stats.tokens.output + snapshot.stats.tokens.cacheRead + snapshot.stats.tokens.cacheWrite + snapshot.stats.tokens.reasoning} tok`
  // Narrow windows drop the right-side counters instead of wrapping them
  // onto the strip row below.
  const showRight = props.width >= 52
  const leftBudget = Math.max(4, props.width - 2 - (showRight ? stringWidth(effortText) + stringWidth(rightRest) + 1 : 0))
  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(Math.max(1, props.width))}</Text>
      <Box justifyContent="space-between" paddingX={1}>
        <Text wrap="truncate" color={themed(snapshot.busy ? 'yellow' : 'cyan', props.theme, 'cyan')}>{shorten(left, leftBudget)}</Text>
        {showRight ? (
          <Box>
            <Text bold color={themed('magenta', props.theme, 'magenta')}>{effortText}</Text>
            <Text dimColor>{rightRest}</Text>
          </Box>
        ) : null}
      </Box>
      <Text dimColor wrap="truncate">{fitStatsStrip(formatStats(snapshot.stats, props.locale, snapshot.occupancy), props.width - 2)}</Text>
    </Box>
  )
}

/** The pinned permission row above the composer: mode label colored by policy plus the Shift+Tab hint. */
function PermissionBar(props: {
  snapshot: ReturnType<TuiStore['getSnapshot']>
  width: number
  locale: Locale
  theme: 'dark' | 'light'
}): React.ReactElement {
  const copy = COPY[props.locale]
  const chip = copy.permissionChip(permissionLabel(props.snapshot.sandbox))
  const hint = copy.permissionHint
  const space = Math.max(4, props.width - 2)
  const hintFits = stringWidth(hint) <= space - 10
  const chipMax = Math.max(4, space - (hintFits ? stringWidth(hint) : 0))
  const chipText = stringWidth(chip) <= chipMax ? chip : fitDisplayText(chip, chipMax)
  return (
    <Box paddingX={1}>
      <Text bold wrap="truncate" color={themed(permissionColor(props.snapshot.sandbox), props.theme, 'whiteBright')}>
        {chipText}
      </Text>
      {hintFits ? <Text dimColor wrap="truncate">{hint}</Text> : null}
    </Box>
  )
}

/** The approval/question takeover occupying the budgeted rows above the composer. */
function Takeover(props: {
  snapshot: ReturnType<TuiStore['getSnapshot']>
  approvalSel: number
  questionIndex: number
  questionSel: number
  questionText: string
  width: number
  height: number
  locale: Locale
}): React.ReactElement {
  const approval = props.snapshot.pendingApproval
  const question = props.snapshot.pendingQuestion?.questions[
    Math.min(props.questionIndex, (props.snapshot.pendingQuestion?.questions.length ?? 1) - 1)
  ]
  const copy = COPY[props.locale]
  return (
    <Box flexDirection="column" paddingX={1} height={Math.max(1, props.height)} overflow="hidden">
      {approval !== null ? (
        <>
          <Text wrap="truncate" color="yellow" bold>{`${copy.approval}${approval.toolName}`}</Text>
          {approval.reason !== undefined && approval.reason !== '' && <Text wrap="truncate" dimColor>({sanitizeTerminalText(approval.reason)})</Text>}
          <Text wrap="truncate" bold={props.approvalSel === 0} {...props.approvalSel === 0 ? { color: 'yellow' } : {}}>
            {props.approvalSel === 0 ? '▸' : ' '} {copy.allowOnce}
          </Text>
          <Text wrap="truncate" bold={props.approvalSel === 1} {...props.approvalSel === 1 ? { color: 'yellow' } : {}}>
            {props.approvalSel === 1 ? '▸' : ' '} {copy.deny}
          </Text>
          <Text wrap="truncate" dimColor>{copy.approvalHint}</Text>
        </>
      ) : question !== undefined ? (
        <>
          <Text wrap="truncate" color="yellow" bold>? {sanitizeTerminalText(question.question)}</Text>
          {question.detail !== undefined && <Text wrap="truncate" dimColor>{sanitizeTerminalText(question.detail)}</Text>}
          {(question.options ?? []).length > 0 && props.questionText === ''
            ? (question.options ?? []).map((option, index) => (
              <Text wrap="truncate" key={option.label} bold={index === props.questionSel} {...index === props.questionSel ? { color: 'yellow' } : {}}>
                {index === props.questionSel ? '▸' : ' '} ○ {sanitizeTerminalText(option.label)}
                {option.description !== undefined ? ` · ${sanitizeTerminalText(option.description)}` : ''}
              </Text>
            ))
            : <Text wrap="truncate" color="cyan">› {props.questionText || copy.questionInput}</Text>}
          <Text wrap="truncate" dimColor>{copy.questionHint}</Text>
        </>
      ) : null}
    </Box>
  )
}

/** One /settings panel page id. */
type PanelKind = 'settings' | 'jobs' | 'subagents' | 'workflows' | 'sessions' | 'plugin-config'

/** The app root. */
export function App(props: {
  store: TuiStore
  host: TuiHost
}): React.ReactElement {
  const { stdout } = useStdout()
  const { exit } = useApp()
  const snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  const theme = snapshot.settings?.general.theme ?? 'dark'
  const locale = snapshot.settings?.general.locale ?? 'zh'
  const copy = COPY[locale]
  const [terminalSize, setTerminalSize] = useState(() => ({
    width: stdout.columns ?? 100,
    height: stdout.rows ?? 30,
  }))
  // The layout must never exceed the PHYSICAL terminal: a frame wider or
  // taller than the window wraps rows onto each other (text bleeding into
  // the next line, broken borders). The floors are sanity guards only.
  const width = Math.max(20, terminalSize.width)
  const rowCount = Math.max(6, terminalSize.height)
  // The transcript reserves its LAST column for the right-edge scrollbar
  // gutter (a browser-style strip rendered by its own Box), so every
  // transcript line wraps at width - 3: one left-margin cell, width - 3
  // content cells, one right-margin cell, then the gutter column.
  const transcriptContentWidth = Math.max(1, width - 3)

  const [tick, setTick] = useState(0)
  const [draft, setDraft] = useState('')
  const [paletteDismissedInput, setPaletteDismissedInput] = useState<string | null>(null)
  const [paletteSelectedIndex, setPaletteSelectedIndex] = useState(0)
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0)
  const transcriptMaximumOffset = useRef(0)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [thinkCollapsed, setThinkCollapsed] = useState<ReadonlySet<number>>(new Set())
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [viewMode, setViewMode] = useState<'chat' | 'trajectory'>('chat')
  const [notice, setNotice] = useState('')
  const [approvalSel, setApprovalSel] = useState(0)
  const [questionIndex, setQuestionIndex] = useState(0)
  const [questionSel, setQuestionSel] = useState(0)
  const [questionText, setQuestionText] = useState('')
  const [panel, setPanel] = useState<{ kind: PanelKind; settingsPage: SettingsPageId; filter?: string } | null>(null)
  const [settingsSel, setSettingsSel] = useState(0)
  const [settingsTop, setSettingsTop] = useState(0)
  const [settingsEdit, setSettingsEdit] = useState<string | null>(null)
  const [settingsEditText, setSettingsEditText] = useState('')
  const [settingsConfirm, setSettingsConfirm] = useState<string | null>(null)
  const [pluginEdit, setPluginEdit] = useState<{ ns: string; field: string; kind: 'string' | 'number' | 'secret' } | null>(null)
  const [pluginEditText, setPluginEditText] = useState('')
  const lastCtrlCAt = useRef(0)
  // Whether a left-button press on the right-edge scrollbar column is being
  // dragged; button-motion reports keep scrolling until the release.
  const scrollbarDragRef = useRef(false)
  // Shell-style input history (cmd/PowerShell ↑/↓ recall), in-memory only.
  const historyRef = useRef<string[]>([])
  const historyScratchRef = useRef('')
  const [historyIndex, setHistoryIndex] = useState(-1)

  const pendingApproval = snapshot.pendingApproval
  const pendingQuestion = snapshot.pendingQuestion
  const panelOpen = panel !== null
  const settingsPage = panel?.settingsPage ?? 'general'

  const refreshTerminalSize = useCallback(() => {
    setTerminalSize({ width: stdout.columns ?? 100, height: stdout.rows ?? 30 })
  }, [stdout])

  useEffect(() => {
    stdout.on('resize', refreshTerminalSize)
    return () => { stdout.off('resize', refreshTerminalSize) }
  }, [refreshTerminalSize, stdout])

  useEffect(() => {
    stdout.write(ENABLE_WHEEL_MOUSE)
    return () => { stdout.write(DISABLE_WHEEL_MOUSE) }
  }, [stdout])
  // Terminal tab/window title: set `🐋 DeepSeek Harness` at mount through
  // the OSC sequence, keep it for the session, and restore the previous
  // title (captured from the `ESC[21t` report arriving on stdin) on exit.
  // Terminals without title support ignore the writes silently.
  const restoredTitleRef = useRef('')
  useEffect(() => {
    const restore = installTerminalTitle(stdout, restoredTitleRef)
    return restore
  }, [stdout])
  // The thinking timer, gradient tick, and retry countdown shimmer while a
  // turn streams, a compaction runs, or a retry wait is pending.
  const hasPendingRetry = snapshot.nodes.some(node => node.kind === 'retry' && !node.started && node.retryAt > Date.now())
  useEffect(() => {
    if (!snapshot.busy && !hasPendingRetry && !snapshot.compaction) return
    const interval = setInterval(() => { setTick(value => value + 1) }, 100)
    return () => { clearInterval(interval) }
  }, [snapshot.busy, hasPendingRetry, snapshot.compaction])

  // The /jobs panel polls its rows once a second while open.
  useEffect(() => {
    if (panel?.kind !== 'jobs') return
    const interval = setInterval(() => { props.host.refreshPanels() }, 1000)
    return () => { clearInterval(interval) }
  }, [panel?.kind, props.host])

  // A takeover arriving while a panel owns the screen must not stay invisible.
  useEffect(() => {
    if (panelOpen && (pendingApproval !== null || pendingQuestion !== null)) {
      setSettingsEdit(null)
      setSettingsEditText('')
      setSettingsConfirm(null)
      setPluginEdit(null)
      setPluginEditText('')
      setPanel(null)
    }
  }, [panelOpen, pendingApproval, pendingQuestion])

  // The combined slash catalog: TUI-local commands first, then host commands.
  // A host command whose name a local command already owns (e.g. `goal`) is
  // SKIPPED here — the palette shows one row per name; execution semantics
  // are unchanged (the exact `/goal` stays local, `/goal <text>` still
  // reaches the host command). Host descriptions get their Chinese copy in
  // the zh locale.
  const commands = useMemo(() => {
    const local = localCommands(locale)
    const localNames = new Set(local.map(command => command.name))
    const host = snapshot.commands
      .filter(command => !localNames.has(command.name))
      .map((command) => {
        const localized = locale === 'zh' ? HOST_COMMAND_ZH[command.name] : undefined
        return {
          name: command.name,
          description: localized ?? command.description,
          needsArgs: command.needsArgs,
        }
      })
    return [...local, ...host]
  }, [locale, snapshot.commands])
  const slashMatchesFor = (value: string): { name: string; description: string; needsArgs: boolean }[] => {
    if (!value.startsWith('/')) return []
    const query = value.slice(1)
    // Alphabetical a→z by command name, top to bottom.
    return commands
      .filter(command => command.name.startsWith(query.trim()))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
  const palette = useMemo(() => {
    if (paletteDismissedInput === draft || panelOpen || pendingApproval !== null || pendingQuestion !== null) return null
    const matches = slashMatchesFor(draft)
    if (matches.length === 0) return null
    return matches
  }, [draft, paletteDismissedInput, panelOpen, pendingApproval, pendingQuestion, commands])

  useEffect(() => {
    setPaletteSelectedIndex(current =>
      palette === null ? 0 : Math.min(current, palette.length - 1))
  }, [palette])

  // ── transcript lines ──────────────────────────────────────────────────
  const thinkDefaultOpen = snapshot.settings?.general.thinking === 'expanded'
  const expandedOf = (node: TuiNode): boolean => node.kind === 'think'
    ? expanded.has(node.id) || (thinkDefaultOpen && !thinkCollapsed.has(node.id))
    : expanded.has(node.id)
  // The 100ms tick drives the spinner frame, the live Thinking shimmer, and
  // the retry shimmer (500ms per flip). Settled node projections stay out of
  // the tick: recomputing up to 3000 nodes ten times a second during a busy
  // turn is bounded; the cap only guards pathological sessions and must not
  // drop the first user message out of the scrollable history.
  const retryShimmer = hasPendingRetry && Math.floor(tick / 5) % 2 === 0

  // ── layout budget ─────────────────────────────────────────────────────
  // A panel action's notice pins one dim row under the panel list, so the
  // feedback stays visible while the panel remains open.
  const panelNoticeVisible = panelOpen && notice !== ''
  // The composer becomes the masked credential/plugin-config editor while a
  // credential row or plugin field is being edited inside a panel.
  const composerDraft = pluginEdit !== null
    ? pluginEditText
    : settingsEdit !== null
      ? settingsEditText
      : draft
  const composerDisplay = pluginEdit?.kind === 'secret'
    ? '•'.repeat([...composerDraft].length)
    : sanitizeTerminalText(composerDraft)
  const composerLines = Math.min(
    MAX_COMPOSER_LINES,
    Math.max(
      1,
      selectComposerLayout(composerDisplay, composerDisplay.length, Math.max(1, width - 4), MAX_COMPOSER_LINES).visibleLines.length,
    ),
  )
  // The frame must ALWAYS fill the physical rows exactly: the cursor suffix
  // compensation assumes the write ends on the last terminal row, so any
  // clipped row would shift the caret off the input line. Budget the
  // palette and the takeover down (in that order) until the chrome fits.
  const reserved = 4 + 1 + composerLines + 1 + 3 + (panelNoticeVisible ? 1 : 0)
  let takeoverH = pendingApproval !== null || pendingQuestion !== null ? 6 : 0
  const fullPaletteH = palette !== null ? Math.min(MAX_POPUP_ITEMS + 2, Math.min(MAX_POPUP_ITEMS, palette.length) + 2) : 0
  const paletteH = Math.min(fullPaletteH, Math.max(0, rowCount - reserved - takeoverH - 1))
  takeoverH = Math.min(takeoverH, Math.max(0, rowCount - reserved - paletteH - 1))
  const fixedRows = reserved + takeoverH + paletteH
  const transcriptHeight = Math.max(1, rowCount - fixedRows)
  const panelHeight = Math.max(1, transcriptHeight - 1 - (panelNoticeVisible ? 1 : 0))

  const settledLines = useMemo((): TranscriptLine[] => {
    if (viewMode === 'trajectory') {
      return snapshot.trace
        .slice(Math.max(0, snapshot.trace.length - 3000))
        .map((entry, index) => {
          // One flat row per trace entry, truncated to the content width so a
          // long entry can never wrap and shift the rows below it.
          const text = fitDisplayText(`· ${sanitizeTerminalText(entry.text)}`, transcriptContentWidth)
          // Structured-trajectory palette: model turns blue, tool activity red,
          // user input cyan, structural boundaries dim.
          const color = traceLineColor(text)
          return {
            key: `trace-${entry.id}-${index}`,
            text,
            ...(color === undefined ? { dim: true } : { color }),
          }
        })
    }
    const nodes = snapshot.nodes.slice(Math.max(0, snapshot.nodes.length - 3000))
    const lines: TranscriptLine[] = []
    if (nodes.length === 0) {
      // First load of a NEW session only: the whale banner. Any event
      // (user message, resume replay, …) fills `nodes`, so the banner can
      // never reappear later in the session.
      const banner = welcomeBanner(transcriptContentWidth, transcriptHeight)
      if (banner.length > 0) {
        banner.forEach((entry, index) => {
          lines.push({
            key: `welcome-${index}`,
            text: entry.text,
            ...(entry.runs !== undefined ? { runs: entry.runs } : {}),
            ...(entry.color !== undefined ? { color: entry.color } : {}),
          })
        })
      } else {
        // Too narrow/short for the art: the plain adaptive welcome card.
        welcomeBlock(transcriptContentWidth, snapshot.model, snapshot.cwd, snapshot.sessionId, locale).forEach((line, index) => {
          const chrome = line.startsWith('┏') || line.startsWith('┃') || line.startsWith('┗')
          lines.push({ key: `welcome-${index}`, text: line, ...(chrome ? { color: 'yellow' } : { dim: true }) })
        })
      }
    }
    for (const node of nodes) {
      lines.push(...nodeLines(
        node, transcriptContentWidth, expandedOf(node), node.id === selectedId, retryShimmer, snapshot.feedback, locale,
      ))
    }
    return lines
  }, [
    viewMode, snapshot.nodes, snapshot.trace, snapshot.model, snapshot.cwd, snapshot.sessionId, width, transcriptHeight,
    expanded, thinkCollapsed, thinkDefaultOpen, selectedId, retryShimmer, snapshot.feedback, locale,
  ])
  const liveThinkLines = useMemo((): TranscriptLine[] => {
    if (snapshot.live === null || !snapshot.busy || snapshot.live.think === '') return []
    // Claude Code style: the original spinning glyph stays up front, and the
    // " Thinking" letters carry a soft grayscale highlight window sweeping
    // left to right. The base gray is medium-bright (readable, clearly
    // dimmer than assistant output). Ink diffs the frame, so only this row
    // rewrites in place each tick.
    const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    const label = `${spinner[tick % spinner.length]} Thinking`
    const elapsed = snapshot.live.thinkSince === null ? 0 : Date.now() - snapshot.live.thinkSince
    const runs = [
      ...[...label].map((character, index) => ({
        text: character,
        color: thinkingShimmerHex(thinkingShimmerLevel(index, tick, label.length)),
      })),
      { text: ` ${(elapsed / 1000).toFixed(1)}s…`, color: '#969696' },
    ]
    // Stable keys: this row re-renders every tick; a position-derived key
    // would churn as the transcript grows and can leave stale rows.
    const lines: TranscriptLine[] = [{ key: 'live-think', text: '', runs }]
    const tail = snapshot.live.think.split('\n').at(-1) ?? ''
    if (tail !== '') {
      // Bound the preview to one row: a longer tail would wrap onto the next
      // line without its `│` prefix and overwrite the row below.
      const tailSpace = Math.max(8, transcriptContentWidth - 3)
      const content = stringWidth(tail) <= tailSpace ? tail : `…${tail.slice(-(tailSpace - 1))}`
      lines.push({
        key: 'live-think-tail',
        text: `  │ ${content}`,
        dim: true,
      })
    }
    return lines
  }, [snapshot.live, snapshot.busy, width, tick])
  const liveTextLines = useMemo((): TranscriptLine[] => {
    if (snapshot.live === null || !snapshot.busy || snapshot.live.text === '') return []
    return wrapText(`● ${snapshot.live.text}▌`, transcriptContentWidth).map((text, index) => ({
      key: `live-text-${index}`, text,
    }))
  }, [snapshot.live?.text, snapshot.busy, width])
  const allLines: TranscriptLine[] = [...settledLines, ...liveThinkLines, ...liveTextLines]
  // A compaction run draws the same shimmer style as Thinking: the
  // spinning glyph plus a grayscale highlight sweeping the label.
  if (snapshot.compaction) {
    const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    const label = `${spinner[tick % spinner.length]} compacting…`
    allLines.push({
      key: 'live-compact',
      text: '',
      runs: [...label].map((character, index) => ({
        text: character,
        color: thinkingShimmerHex(thinkingShimmerLevel(index, tick, label.length)),
      })),
    })
  }
  if (notice !== '') {
    wrapText(notice, transcriptContentWidth).forEach((line, index) => {
      allLines.push({ key: `notice-${index}`, text: line, color: 'gray' })
    })
  }
  // dsh docks render at the transcript tail so follow mode keeps them
  // visible right above the composer. Each dock is ONE transcript row and
  // must never exceed the content width: an overlong row would wrap onto
  // the next line and shift every row below it (breaking the frame and the
  // right-edge scrollbar alignment), so docks truncate with an ellipsis.
  if (snapshot.queued.length > 0) {
    const preview = snapshot.queued.map(entry => `${entry.steer ? '▸▸ ' : ''}${sanitizeTerminalText(entry.text)}`).join(' · ')
    allLines.push({ key: 'queue-dock', text: fitDisplayText(`${copy.queueDock} ${snapshot.queued.length}：${preview}`, transcriptContentWidth), color: 'yellow' })
  }
  if (snapshot.todos.length > 0) {
    const pending = snapshot.todos.filter(todo => todo.status === 'pending').length
    const active = snapshot.todos.filter(todo => todo.status === 'in_progress').length
    const done = snapshot.todos.filter(todo => todo.status === 'completed').length
    allLines.push({ key: 'todo-dock', text: fitDisplayText(`${copy.todoDock} ${copy.todoCounts(active, pending, done)}`, transcriptContentWidth), color: 'yellow' })
  }
  // The goal dock mirrors the Web goal panel in one transcript-tail row.
  if (snapshot.goal !== null) {
    const phaseLabel = snapshot.goal.phase === 'active' ? copy.goalActive
      : snapshot.goal.phase === 'paused' ? copy.goalPaused
        : snapshot.goal.phase === 'blocked' ? copy.goalBlocked(snapshot.goal.blockedReason?.message ?? snapshot.goal.blockedReason?.code ?? '')
          : copy.goalComplete
    const objective = snapshot.goal.objective.length <= 80 ? snapshot.goal.objective : `${snapshot.goal.objective.slice(0, 80)}…`
    allLines.push({
      key: 'goal-dock',
      text: fitDisplayText(`${copy.goalDock} [${phaseLabel}] · round ${snapshot.goal.roundsStarted}/${snapshot.goal.maxGoalRounds} · ${objective}`, transcriptContentWidth),
      color: 'yellow',
    })
  }
  // Pending image attachments ride the next user message (Web composer chips).
  if (snapshot.attachmentCount > 0) {
    allLines.push({ key: 'attach-dock', text: fitDisplayText(copy.attachCount(snapshot.attachmentCount), transcriptContentWidth), color: 'yellow' })
  }

  // The view stays on the same CONTENT while new lines stream in at the
  // tail: compensate only for real line growth, never for chrome changes
  // (the back-button reservation also moves the maximum).
  const transcriptLineCountRef = useRef(0)
  const updateTranscriptMaximumOffset = useCallback((maximumOffset: number, lineCount: number) => {
    transcriptMaximumOffset.current = maximumOffset
    const grew = Math.max(0, lineCount - transcriptLineCountRef.current)
    transcriptLineCountRef.current = lineCount
    setTranscriptScrollOffset((current) => {
      if (current === 0) return 0
      return Math.min(maximumOffset, Math.max(0, current + grew))
    })
  }, [])

  const pageSize = Math.max(1, rowCount - 12)

  // ── panels ────────────────────────────────────────────────────────────
  const settingsRows = useMemo((): PanelRow[] => {
    if (panel === null) return []
    switch (panel.kind) {
      case 'settings': return buildSettingsRows(snapshot, panel.settingsPage, locale)
      case 'jobs': return buildJobsRows(snapshot.jobs, locale)
      case 'subagents': return buildSubagentRows(snapshot.subagents, locale)
      case 'workflows': return buildWorkflowRows(snapshot.workflows, locale)
      case 'sessions': return buildSessionRows(snapshot.sessions, panel.filter, locale)
      case 'plugin-config': return buildPluginConfigRows(snapshot.settings?.configs[panel.filter ?? ''] ?? [], panel.filter ?? '', locale)
    }
  }, [snapshot, panel, locale])
  const settingsViewport = selectPanelViewport(settingsRows.map(row => ({
    key: row.key,
    text: row.text,
    ...(row.color !== undefined ? { color: row.color } : {}),
    dim: row.dim === true,
  })), panelHeight, settingsTop)
  const settingsSelClamped = Math.max(0, Math.min(settingsSel, settingsRows.length - 1))

  // ── command routing ───────────────────────────────────────────────────
  const openPanel = useCallback((kind: PanelKind, settingsPageArg: SettingsPageId = 'general', filter?: string): void => {
    setPanel({
      kind,
      settingsPage: settingsPageArg,
      ...(filter === undefined ? {} : { filter }),
    })
    setSettingsSel(0)
    setSettingsTop(0)
    setSettingsEdit(null)
    setSettingsEditText('')
    setSettingsConfirm(null)
    setPluginEdit(null)
    setPluginEditText('')
    setDraft('')
    setPaletteDismissedInput(null)
    setNotice('')
    if (kind === 'settings') {
      // The plugins page reflects the loader tree, which hot-applies patches
      // asynchronously: refresh on open so a slow toggle never leaves a
      // stale ●/○ row visible after re-entering the panel.
      props.host.refreshSettings()
    } else {
      props.host.refreshPanels()
    }
  }, [props.host])

  // A launcher-provided startup panel (bare --resume picker, or an ambiguous
  // --resume query) opens once the app mounts; the host object is stable for
  // the surface's lifetime, so the effect runs on mount only.
  useEffect(() => {
    const panel = props.host.startup?.panel
    if (panel !== undefined) openPanel(panel.kind, 'general', panel.filter)
  }, [openPanel, props.host])

  const executeCommand = useCallback((raw: string): void => {
    const text = raw.trim()
    if (text === '') return
    if (text === '/quit' || text === '/exit') {
      exit()
      return
    }
    if (text === '/help') {
      setNotice(helpText(locale))
      return
    }
    if (text === '/clear') {
      setNotice('')
      return
    }
    if (text === '/trajectory') {
      setViewMode(viewMode === 'chat' ? 'trajectory' : 'chat')
      setTranscriptScrollOffset(0)
      return
    }
    if (text === '/settings' || text.startsWith('/settings ')) {
      const argument = text.split(' ')[1]
      openPanel('settings', SETTINGS_PAGES.includes(argument as SettingsPageId) ? argument as SettingsPageId : 'general')
      return
    }
    if (text === '/jobs' || text === '/subagents' || text === '/workflows') {
      openPanel(text.slice(1) as PanelKind)
      return
    }
    if (text === '/sessions' || text.startsWith('/sessions ')) {
      const query = text === '/sessions' ? undefined : text.slice('/sessions '.length).trim()
      openPanel('sessions', 'general', query === '' ? undefined : query)
      return
    }
    if (text === '/presets') {
      openPanel('settings', 'presets')
      return
    }
    if (text === '/goal') {
      const goal = snapshot.goal
      if (goal === null) {
        setNotice(copy.goalNone)
        return
      }
      const phaseLabel = goal.phase === 'active' ? copy.goalActive
        : goal.phase === 'paused' ? copy.goalPaused
          : goal.phase === 'blocked' ? copy.goalBlocked(goal.blockedReason?.message ?? goal.blockedReason?.code ?? '')
            : copy.goalComplete
      const lines = [
        copy.goalDetail(goal.revision, phaseLabel, goal.roundsStarted, goal.maxGoalRounds),
        `${copy.goalObjective}${goal.objective}`,
        ...(goal.blockedReason !== undefined ? [copy.goalBlockedLine(goal.blockedReason.code, goal.blockedReason.message)] : []),
        copy.goalCreated(new Date(goal.createdAt).toLocaleString(), new Date(goal.updatedAt).toLocaleString()),
      ]
      setNotice(lines.join('\n'))
      return
    }
    if (text === '/effort' || text.startsWith('/effort ')) {
      const argument = text === '/effort' ? '' : text.slice('/effort '.length).trim()
      if (argument !== 'off' && argument !== 'high' && argument !== 'max') {
        setNotice(copy.effortUsage)
        return
      }
      props.host.setEffort(argument === 'off' ? undefined : argument)
      setNotice(copy.effortChanged(argument))
      return
    }
    if (text === '/new') {
      props.host.newSession()
      setTranscriptScrollOffset(0)
      return
    }
    if (text === '/rename' || text.startsWith('/rename ')) {
      const title = text === '/rename' ? '' : text.slice('/rename '.length).trim()
      if (title === '') {
        setNotice(copy.renameUsage)
        return
      }
      void props.host.renameSession(title).then((error) => {
        setNotice(error === null ? copy.renameDone(title) : error)
      })
      return
    }
    if (text === '/workspace' || text.startsWith('/workspace ')) {
      const path = text === '/workspace' ? '' : text.slice('/workspace '.length).trim()
      if (path === '') {
        setNotice(copy.workspaceUsage)
        return
      }
      void props.host.changeWorkspace(path).then((error) => {
        setNotice(error === null ? copy.workspaceDone(path) : error)
      })
      return
    }
    if (text === '/attach' || text.startsWith('/attach ')) {
      const path = text === '/attach' ? '' : text.slice('/attach '.length).trim()
      if (path === '') {
        setNotice(copy.attachUsage)
        return
      }
      void props.host.attachFile(path).then((error) => {
        setNotice(error === null ? copy.attachDone(path) : error)
      })
      return
    }
    if (text === '/fork' || text.startsWith('/fork ')) {
      const argument = text === '/fork' ? '' : text.slice('/fork '.length).trim()
      const atSeq = argument === '' ? undefined : Number(argument)
      if (atSeq !== undefined && !Number.isSafeInteger(atSeq)) {
        setNotice(copy.forkUsage)
        return
      }
      void props.host.forkSession(atSeq).then((error) => {
        setNotice(error === null ? copy.forkDone : error)
      })
      return
    }
    if (text === '/model') {
      openPanel('settings', 'models')
      return
    }
    // Anything else routes through the host: registered slash commands
    // dispatch without a model turn; unknown lines become model messages.
    props.host.submit(text, false)
    setNotice('')
  }, [exit, viewMode, snapshot, props.host, openPanel, locale, copy])

  const submit = useCallback((value: string, steer = false): void => {
    const trimmed = value.trim()
    if (!trimmed) return
    if (trimmed.startsWith('/')) {
      setDraft('')
      executeCommand(trimmed)
      return
    }
    const inputBytes = Buffer.byteLength(trimmed, 'utf8')
    if (inputBytes > MAX_TURN_INPUT_BYTES) {
      setNotice(copy.inputTooLarge(inputBytes, MAX_TURN_INPUT_BYTES))
      return
    }
    setDraft('')
    setTranscriptScrollOffset(0)
    const busyEnter = snapshot.settings?.general.busyEnter ?? 'queue'
    const effectiveSteer = snapshot.busy
      ? (steer ? busyEnter !== 'steer' : busyEnter === 'steer')
      : steer
    props.host.submit(trimmed, effectiveSteer)
    setNotice('')
    // Record the submission for shell-style ↑/↓ recall (consecutive
    // duplicates collapse, like cmd/PowerShell).
    const history = historyRef.current
    if (history[history.length - 1] !== trimmed) history.push(trimmed)
    historyScratchRef.current = ''
    setHistoryIndex(-1)
  }, [executeCommand, snapshot.busy, snapshot.settings?.general.busyEnter, props.host, copy])

  const applyPalette = useCallback((completeOnly: boolean): void => {
    if (palette === null) return
    const item = palette[Math.min(paletteSelectedIndex, palette.length - 1)]
    if (item === undefined) return
    if (completeOnly || item.needsArgs) {
      setDraft(`/${item.name} `)
      setPaletteDismissedInput(null)
      setPaletteSelectedIndex(0)
      return
    }
    setDraft('')
    setPaletteDismissedInput(null)
    executeCommand(`/${item.name}`)
  }, [palette, paletteSelectedIndex, executeCommand])

  /** Commit the composer's plugin-config edit into the namespace. */
  const commitPluginEdit = useCallback((): void => {
    if (pluginEdit === null) return
    const { ns, field, kind } = pluginEdit
    let value: unknown = pluginEditText
    if (kind === 'number') {
      const parsed = Number(pluginEditText.trim())
      if (!Number.isFinite(parsed)) {
        setNotice(copy.invalidNumber)
        return
      }
      value = parsed
    }
    setPluginEdit(null)
    setPluginEditText('')
    void props.host.updatePluginConfig(ns, { [field]: value }).then((error) => {
      setNotice(error === null ? copy.fieldUpdated(field) : error)
    })
  }, [pluginEdit, pluginEditText, props.host, copy])

  const submitComposer = useCallback((value: string, steer = false): void => {
    if (pluginEdit !== null) {
      commitPluginEdit()
      return
    }
    if (settingsEdit !== null) {
      commitCredentialEdit()
      return
    }
    if (palette !== null && palette.length > 0) {
      applyPalette(false)
      return
    }
    if (panelOpen) return
    submit(value, steer)
  }, [pluginEdit, commitPluginEdit, settingsEdit, settingsEditText, settingsConfirm, palette, applyPalette, panelOpen, submit])

  // ── settings credential edit through the composer ────────────────────
  const commitCredentialEdit = useCallback((): void => {
    if (settingsEdit === null) return
    const row = settingsRows.find(entry => entry.key === settingsEdit)
    const ref = row?.meta?.ref
    if (ref === undefined) {
      setSettingsEdit(null)
      setSettingsEditText('')
      return
    }
    if (settingsConfirm !== null) {
      void props.host.setCredential(ref, settingsEditText).then(() => {
        setNotice(copy.credentialWritten(ref))
      }).catch((error: unknown) => {
        setNotice(copy.credentialWriteFailed(error instanceof Error ? error.message : String(error)))
      })
      setSettingsConfirm(null)
      setSettingsEdit(null)
      setSettingsEditText('')
      return
    }
    if (settingsEditText === '') {
      void props.host.unsetCredential(ref).then(() => {
        setNotice(copy.credentialRemoved(ref))
      }).catch((error: unknown) => {
        setNotice(copy.credentialRemoveFailed(error instanceof Error ? error.message : String(error)))
      })
      setSettingsEdit(null)
      return
    }
    setSettingsConfirm(settingsEdit)
  }, [settingsEdit, settingsEditText, settingsConfirm, settingsRows, props.host, copy])

  /** Activate the panel row under the cursor. */
  const activateSettingsRow = useCallback((row: PanelRow | undefined): void => {
    if (row === undefined || row.action === undefined) return
    switch (row.action) {
      case 'toggle-busy-enter': {
        const next = snapshot.settings?.general.busyEnter === 'steer' ? 'queue' : 'steer'
        void props.host.updateSetting({ busyEnter: next }).then(() => {
          setNotice(copy.busyEnterChanged(next))
        }).catch(() => {})
        return
      }
      case 'toggle-thinking': {
        const next = snapshot.settings?.general.thinking === 'expanded' ? 'collapsed' : 'expanded'
        void props.host.updateSetting({ thinking: next }).then(() => {
          setNotice(copy.thinkingChanged(next))
        }).catch(() => {})
        return
      }
      case 'toggle-theme': {
        const next = snapshot.settings?.general.theme === 'light' ? 'dark' : 'light'
        void props.host.updateSetting({ theme: next }).then(() => {
          setNotice(copy.themeChanged(next))
        }).catch(() => {})
        return
      }
      case 'toggle-locale': {
        const next = snapshot.settings?.general.locale === 'en' ? 'zh' : 'en'
        void props.host.updateSetting({ locale: next }).then(() => {
          setNotice(copy.localeChanged(next))
        }).catch(() => {})
        return
      }
      case 'select-model': {
        if (row.meta?.provider === undefined || row.meta.model === undefined) return
        props.host.selectModel(row.meta.provider, row.meta.model)
        setNotice(copy.modelDefault(row.meta.model))
        return
      }
      case 'select-reasoning-effort': {
        if (row.meta?.provider === undefined || row.meta.model === undefined || row.meta.effort === undefined) return
        props.host.selectModel(row.meta.provider, row.meta.model, row.meta.effort)
        setNotice(copy.effortDefault(row.meta.effort))
        return
      }
      case 'edit-credential': {
        const credential = snapshot.settings?.models.credentials.find(entry => entry.ref === row.meta?.ref)
        if (credential === undefined) return
        if (!credential.writable) {
          setNotice(copy.credentialReadOnly(credential.ref))
          return
        }
        setSettingsEdit(row.key)
        setSettingsEditText('')
        return
      }
      case 'kill-job': {
        if (row.meta?.id === undefined) return
        props.host.killJob(row.meta.id)
        setNotice(copy.killJobRequested(row.meta.id))
        return
      }
      case 'resume-session': {
        if (row.meta?.id === undefined) return
        void props.host.resumeSession(row.meta.id).then((error) => {
          if (error !== null) {
            setNotice(error)
          } else {
            setNotice(copy.resumeDone(row.meta?.id ?? ''))
            setPanel(null)
            // The resumed transcript starts at the newest history tail:
            // drop any stale scroll offset and selection from before.
            setTranscriptScrollOffset(0)
            setSelectedId(null)
          }
        })
        return
      }
      case 'select-preset': {
        if (row.meta?.id === undefined) return
        void props.host.switchPreset(row.meta.id).then((error) => {
          if (error !== null) {
            setNotice(error)
          } else {
            // The switch is IN PLACE (the Web mechanism): the panel stays
            // open so the ● marker can move to the new preset.
            setNotice(copy.presetSwitched(row.meta?.id ?? ''))
          }
        })
        return
      }
      case 'toggle-plugin': {
        if (row.meta?.id === undefined) return
        void props.host.togglePlugin(row.meta.id).then((result) => {
          if ('error' in result) {
            setNotice(result.error)
          } else {
            setNotice(copy.pluginToggled(row.meta?.id ?? '', result.enabled))
          }
        })
        return
      }
      case 'toggle-config-boolean': {
        if (row.meta?.ns === undefined || row.meta.field === undefined) return
        const current = row.text.includes('● ') && row.text.includes('= true')
        void props.host.updatePluginConfig(row.meta.ns, { [row.meta.field]: !current }).then((error) => {
          setNotice(error === null ? `${row.meta?.field ?? ''} → ${!current}` : error)
        })
        return
      }
      case 'edit-config-number':
      case 'edit-config-secret':
      case 'edit-config-string': {
        if (row.meta?.ns === undefined || row.meta.field === undefined) return
        const kind = row.action === 'edit-config-number' ? 'number' : row.action === 'edit-config-secret' ? 'secret' : 'string'
        setPluginEdit({ ns: row.meta.ns, field: row.meta.field, kind })
        // Secrets never prefetch their redacted marker into the draft.
        setPluginEditText(kind === 'secret' ? '' : row.text.split('= ', 2)[1]?.split(' · Enter')[0]?.trim() ?? '')
        return
      }
    }
  }, [snapshot, props.host, copy])

  /** Keep the selected panel row inside the visible window (scroll-follow). */
  const ensurePanelSelectionVisible = useCallback((selected: number): void => {
    setSettingsTop((current) => {
      if (selected < current) return selected
      if (selected >= current + panelHeight) return selected - panelHeight + 1
      return current
    })
  }, [panelHeight])

  const handlePanelKey = useCallback((input: string, key: Key): boolean => {
    // Escape is intercepted upstream and routed through the debounced
    // handleEscape, so only Enter and non-escape panel keys arrive here.
    const isEnter = input.includes('\r') || input.includes('\n') || key.return === true
    if (pluginEdit !== null) {
      if (isEnter) commitPluginEdit()
      return true
    }
    if (settingsConfirm !== null) {
      if (isEnter) {
        commitCredentialEdit()
      }
      return true
    }
    if (settingsEdit !== null) {
      return true
    }
    if (input === 'q' || input === 'Q') {
      // From a plugin-config editor, `q` returns to the plugins list.
      if (panel?.kind === 'plugin-config') {
        openPanel('settings', 'plugins')
        return true
      }
      setPanel(null)
      setNotice('')
      return true
    }
    // On the settings plugins page, `c` opens the selected plugin's config editor.
    if ((input === 'c' || input === 'C') && panel?.kind === 'settings' && panel.settingsPage === 'plugins') {
      const row = settingsRows[settingsSelClamped]
      if (row?.meta?.ns !== undefined) openPanel('plugin-config', 'plugins', row.meta.ns)
      return true
    }
    if (key.tab && panel?.kind === 'settings') {
      const index = SETTINGS_PAGES.indexOf(settingsPage)
      setPanel(previous => previous === null ? previous : {
        ...previous,
        settingsPage: SETTINGS_PAGES[(index + 1) % SETTINGS_PAGES.length] ?? 'general',
      })
      setSettingsSel(0)
      setSettingsTop(0)
      return true
    }
    if (key.upArrow) {
      const next = Math.max(0, settingsSel - 1)
      setSettingsSel(next)
      ensurePanelSelectionVisible(next)
      return true
    }
    if (key.downArrow) {
      const next = Math.min(settingsRows.length - 1, settingsSel + 1)
      setSettingsSel(next)
      ensurePanelSelectionVisible(next)
      return true
    }
    if (key.pageUp) {
      // Top-anchored list: PageUp walks toward the older rows.
      setSettingsTop(value => Math.max(0, value - pageSize))
      return true
    }
    if (key.pageDown) {
      setSettingsTop(value => Math.min(settingsViewport.maximumOffset, value + pageSize))
      return true
    }
    if (isEnter) {
      activateSettingsRow(settingsRows[settingsSelClamped])
      return true
    }
    return false
  }, [
    pluginEdit, commitPluginEdit, settingsConfirm, settingsEdit, commitCredentialEdit, panel, settingsPage, settingsRows, settingsSel,
    settingsSelClamped, settingsViewport.maximumOffset, pageSize, activateSettingsRow, ensurePanelSelectionVisible, openPanel,
  ])

  // ── input routing ─────────────────────────────────────────────────────
  // Every Escape action funnels through here so the 60ms phantom-Escape
  // confirmation window can drop split-CSI artifacts without side effects.
  const handleEscape = useEffectEvent(() => {
    if (pluginEdit !== null) {
      setPluginEdit(null)
      setPluginEditText('')
      return
    }
    if (settingsConfirm !== null) {
      setSettingsConfirm(null)
      setSettingsEdit(null)
      setSettingsEditText('')
      return
    }
    if (settingsEdit !== null) {
      setSettingsEdit(null)
      setSettingsEditText('')
      return
    }
    if (panelOpen) {
      // Esc from a plugin-config editor returns to the plugins list.
      if (panel?.kind === 'plugin-config') {
        openPanel('settings', 'plugins')
        return
      }
      setPanel(null)
      setNotice('')
      return
    }
    if (pendingApproval !== null) {
      props.host.approve('rejected')
      setApprovalSel(0)
      return
    }
    if (pendingQuestion !== null) {
      const question = pendingQuestion.questions[questionIndex]
      if (question !== undefined) {
        props.host.answerQuestion([{ id: question.id, selected: [], custom: '' }])
        setQuestionIndex(questionIndex + 1)
        setQuestionText('')
      }
      return
    }
    if (palette !== null && palette.length > 0) {
      setPaletteDismissedInput(draft)
      return
    }
    if (draft !== '') setDraft('')
    else if (snapshot.busy) props.host.cancel()
    else setSelectedId(null)
  })
  useEffect(() => () => { escapeArbiter.cancel() }, [])

  useInput((input, key) => {
    // The terminal's title report (the `ESC]l<title>ESC\` answer to our
    // `ESC[21t` query) must never reach the composer; capture it for the
    // exit restore. The head may arrive split from the tail.
    const titleReport = /^\x1b?\]l([^\x07\x1b]*)\x1b?(?:\\|\x07)$/.exec(input)
    if (titleReport !== null) {
      restoredTitleRef.current = titleReport[1] ?? ''
      return
    }
    if (input.startsWith(']l')) return
    if (key.escape) {
      escapeArbiter.schedule(() => { handleEscape() })
      return
    }
    // A bare CSI tail inside a pending-Escape window is the second half of a
    // split arrow/function key: cancel the phantom Escape and act as that
    // key. Any other key also cancels it (a real Esc followed by fast typing
    // loses the Esc, which the keypress itself supersedes anyway).
    if (escapeArbiter.hasPending()) {
      const tail = escapeArbiter.cancel() ? csiTailKey(input) : null
      if (tail !== null) {
        key = { ...key, ...syntheticKey(tail) }
      }
    }
    // A fresh '/' keystroke always re-arms the slash picker: any dismissal
    // left behind by an earlier Escape at the same input value must not
    // swallow the next invocation.
    if (input === '/') setPaletteDismissedInput(null)
    if (key.ctrl && input.toLowerCase() === 'c') {
      const now = Date.now()
      if (now - lastCtrlCAt.current <= CTRL_C_EXIT_WINDOW_MS) {
        exit()
        return
      }
      lastCtrlCAt.current = now
      if (snapshot.busy) {
        props.host.cancel()
        setNotice(copy.cancelRequested)
      } else {
        setNotice(copy.exitHint)
      }
      return
    }
    // Shift+Tab rotates the session's file-policy mode (the Web permission
    // control). It may arrive as one `\x1b[Z` chunk or split across the
    // Escape arbiter, which re-synthesizes it as tab+shift by this point.
    // The pinned permission row above the composer shows the new mode, so
    // no extra notice is needed.
    if ((key.shift === true && key.tab === true) || input === '\x1b[Z') {
      props.host.cycleSandbox()
      return
    }
    // The wheel scrolls the panel when one is open, the transcript otherwise.
    // Panels anchor to the TOP, so wheel-up walks toward older rows.
    const wheel = parseMouseWheel(input)
    if (wheel !== null) {
      if (panelOpen) {
        const delta = wheel === 'up' ? -3 : 3
        setSettingsTop(current => Math.max(0, Math.min(settingsViewport.maximumOffset, current + delta)))
      } else {
        setTranscriptScrollOffset(current =>
          scrollOffsetForWheel(current, transcriptMaximumOffset.current, wheel))
      }
      return
    }
    // A mouse CLICK on the floating back-to-bottom button returns to the
    // newest lines; a press on the right-edge scrollbar gutter jumps the
    // transcript to that position and starts a drag (button-motion reports
    // continue it until release). Every other click is consumed without
    // effect. The transcript occupies 1-based rows 5..4+height; the gutter
    // accepts the LAST TWO columns (the rail column plus the content's right
    // margin cell) so the click target is a comfortable 2 cells wide.
    const click = parseMouseReport(input)
    if (click !== null && (click.button & 64) === 0) {
      if ((click.button & 32) !== 0) {
        // Drag motion: follow the pointer along the scrollbar gutter.
        if (scrollbarDragRef.current && !panelOpen) {
          const backButtonVisible = transcriptScrollOffset > 0
          const contentHeight = transcriptHeight - (backButtonVisible ? 1 : 0)
          const maximum = transcriptMaximumOffset.current
          const geometry = selectScrollbar(allLines.length, transcriptHeight, transcriptScrollOffset, backButtonVisible ? 1 : 0)
          if (geometry.visible && click.row >= 5 && click.row <= 4 + contentHeight) {
            setTranscriptScrollOffset(scrollOffsetForScrollbarRow(click.row, 5, contentHeight, maximum))
          }
        }
        return
      }
      if (click.action === 'press' && !panelOpen) {
        if (transcriptScrollOffset > 0 && click.row === 4 + transcriptHeight) {
          setTranscriptScrollOffset(0)
          return
        }
        if (click.button === 0 && click.column >= width - 1) {
          const backButtonVisible = transcriptScrollOffset > 0
          const contentHeight = transcriptHeight - (backButtonVisible ? 1 : 0)
          const maximum = transcriptMaximumOffset.current
          const geometry = selectScrollbar(allLines.length, transcriptHeight, transcriptScrollOffset, backButtonVisible ? 1 : 0)
          if (geometry.visible && click.row >= 5 && click.row <= 4 + contentHeight) {
            scrollbarDragRef.current = true
            setTranscriptScrollOffset(scrollOffsetForScrollbarRow(click.row, 5, contentHeight, maximum))
          }
          return
        }
      }
      if (click.action === 'release') scrollbarDragRef.current = false
      return
    }
    if (panelOpen) {
      handlePanelKey(input, key)
      return
    }
    if (key.pageUp || (key.ctrl && key.home)) {
      setTranscriptScrollOffset((current) => {
        const maximum = transcriptMaximumOffset.current
        return key.home ? maximum : Math.min(maximum, current + pageSize)
      })
      return
    }
    if (key.pageDown || (key.end && (key.ctrl || transcriptScrollOffset > 0))) {
      setTranscriptScrollOffset((current) => {
        const clamped = Math.min(current, transcriptMaximumOffset.current)
        return key.end ? 0 : Math.max(0, clamped - pageSize)
      })
      return
    }
    if (pendingApproval !== null) {
      if (input === 'y' || input === 'Y' || (key.return && approvalSel === 0)) {
        props.host.approve('allowed-once')
        setApprovalSel(0)
      } else if (input === 'n' || input === 'N' || (key.return && approvalSel === 1)) {
        props.host.approve('rejected')
        setApprovalSel(0)
      } else if (key.upArrow || key.downArrow) {
        setApprovalSel(approvalSel === 0 ? 1 : 0)
      }
      return
    }
    if (pendingQuestion !== null) {
      const question = pendingQuestion.questions[questionIndex]
      if (question !== undefined) {
        if ((question.options?.length ?? 0) > 0 && questionText === '') {
          if (key.upArrow) setQuestionSel(Math.max(0, questionSel - 1))
          if (key.downArrow) setQuestionSel(Math.min((question.options?.length ?? 1) - 1, questionSel + 1))
          if (key.return) {
            const selected = (question.options ?? [])[Math.min(questionSel, (question.options?.length ?? 1) - 1)]?.label ?? ''
            props.host.answerQuestion([{ id: question.id, selected: selected === '' ? [] : [selected] }])
            setQuestionIndex(questionIndex + 1)
            setQuestionSel(0)
          }
        } else {
          // Custom answers type straight into questionText (the composer is
          // disabled during the takeover).
          if (key.backspace) setQuestionText(value => value.slice(0, -1))
          else if (key.return) {
            props.host.answerQuestion([{ id: question.id, selected: [], ...(questionText === '' ? {} : { custom: questionText }) }])
            setQuestionIndex(questionIndex + 1)
            setQuestionSel(0)
            setQuestionText('')
          } else if (input !== '' && !key.upArrow && !key.downArrow && !key.tab) {
            setQuestionText(questionText + sanitizeTerminalText(input))
          }
        }
      }
      return
    }
    if (palette !== null && palette.length > 0) {
      if (key.upArrow || key.downArrow) {
        setPaletteSelectedIndex((current) => {
          const count = palette.length
          return key.upArrow ? (current - 1 + count) % count : (current + 1) % count
        })
        return
      }
      if (key.tab) {
        applyPalette(true)
        return
      }
      return
    }
    // Tab (idle) enters/leaves transcript-selection mode. With a row
    // selected, ↑/↓ walk the transcript; without one, ↑/↓ recall input
    // history exactly like cmd/PowerShell.
    if (draft === '' && key.tab) {
      if (selectedId === null) {
        const visibleNodes = snapshot.nodes.slice(Math.max(0, snapshot.nodes.length - 3000))
        setSelectedId(visibleNodes[visibleNodes.length - 1]?.id ?? null)
      } else {
        setSelectedId(null)
      }
      return
    }
    const history = historyRef.current
    if (key.upArrow) {
      if (draft === '' && selectedId !== null) {
        const visibleNodes = snapshot.nodes.slice(Math.max(0, snapshot.nodes.length - 3000))
        const currentIndex = visibleNodes.findIndex(node => node.id === selectedId)
        if (visibleNodes.length > 0) {
          setSelectedId(visibleNodes[Math.max(0, currentIndex - 1)]?.id ?? visibleNodes[0]?.id ?? null)
        }
        return
      }
      if (history.length === 0) return
      if (historyIndex === -1) historyScratchRef.current = draft
      const nextIndex = historyIndex === -1
        ? history.length - 1
        : Math.max(0, historyIndex - 1)
      setHistoryIndex(nextIndex)
      setDraft(history[nextIndex] ?? '')
      setPaletteDismissedInput(null)
      return
    }
    if (key.downArrow) {
      if (draft === '' && selectedId !== null) {
        const visibleNodes = snapshot.nodes.slice(Math.max(0, snapshot.nodes.length - 3000))
        const currentIndex = visibleNodes.findIndex(node => node.id === selectedId)
        if (visibleNodes.length > 0) {
          const nextNode = visibleNodes[Math.min(visibleNodes.length - 1, currentIndex + 1)] ?? visibleNodes[visibleNodes.length - 1]
          setSelectedId(nextNode?.id ?? null)
        }
        return
      }
      if (historyIndex === -1) return
      const nextIndex = historyIndex + 1
      if (nextIndex >= history.length) {
        setHistoryIndex(-1)
        setDraft(historyScratchRef.current)
        historyScratchRef.current = ''
      } else {
        setHistoryIndex(nextIndex)
        setDraft(history[nextIndex] ?? '')
      }
      setPaletteDismissedInput(null)
      return
    }
    // Space expands collapsible rows; g/b rate the selected assistant
    // message (Web feedback parity) — selection mode only.
    if (draft === '' && selectedId !== null) {
      const visibleNodes = snapshot.nodes.slice(Math.max(0, snapshot.nodes.length - 800))
      if (input === ' ') {
        const node = visibleNodes.find(entry => entry.id === selectedId)
        if (node?.kind === 'think') {
          const open = expanded.has(node.id) || (thinkDefaultOpen && !thinkCollapsed.has(node.id))
          if (open) {
            setExpanded((previous) => { const next = new Set(previous); next.delete(node.id); return next })
            setThinkCollapsed((previous) => { const next = new Set(previous); next.add(node.id); return next })
          } else {
            setExpanded((previous) => { const next = new Set(previous); next.add(node.id); return next })
            setThinkCollapsed((previous) => { const next = new Set(previous); next.delete(node.id); return next })
          }
        } else if (node !== undefined && isCollapsible(node)) {
          setExpanded((previous) => {
            const next = new Set(previous)
            if (next.has(selectedId)) next.delete(selectedId)
            else next.add(selectedId)
            return next
          })
        }
        return
      }
      if (input === 'g' || input === 'b') {
        const node = visibleNodes.find(entry => entry.id === selectedId)
        if (node?.kind === 'assistant') {
          const rating = input === 'g' ? 'positive' : 'negative'
          void props.host.rateMessage(node.messageId, rating).then((error) => {
            if (error !== null) setNotice(error)
          })
        }
        return
      }
    }
    if (key.ctrl && input === 'l') {
      setNotice('')
      setDraft('')
      return
    }
    if (key.ctrl && input === 'd') {
      if (draft === '' && !snapshot.busy) exit()
      return
    }
  })

  // The composer becomes the masked credential/plugin-config editor while a
  // credential row or plugin field is being edited inside a panel.
  const composerFocused = pluginEdit !== null || settingsEdit !== null
    ? true
    : pendingApproval === null && pendingQuestion === null && !panelOpen
  const selectedNode = selectedId === null ? undefined : snapshot.nodes.find(node => node.id === selectedId)
  const selectionHint = selectedNode?.kind === 'assistant'
    ? ` ${copy.selAssistant}`
    : selectedNode !== undefined
      ? ` ${copy.selCollapsible}`
      : ''
  // Selection keys belong to the transcript, never the composer: reserve
  // them from ImeTextInput while the draft is empty so g/b/Space cannot
  // pollute the draft (the App handler below owns their actions).
  const reserveSelectionKeys = useCallback((input: string): boolean => {
    if (draft !== '' || selectedId === null) return false
    const node = snapshot.nodes.find(entry => entry.id === selectedId)
    if (node === undefined) return false
    if (input === ' ') return isCollapsible(node)
    if (input === 'g' || input === 'b') return node.kind === 'assistant'
    return false
  }, [draft, selectedId, snapshot.nodes])

  return (
    <Box flexDirection="column" width={width} height={rowCount} overflow="hidden">
      <Header snapshot={snapshot} width={width} theme={theme} />
      {panelOpen ? (
        <PanelView
          rows={settingsRows}
          height={panelHeight}
          offset={settingsTop}
          selectedIndex={settingsSelClamped}
          theme={theme}
        />
      ) : (
        <Transcript
          lines={allLines}
          height={transcriptHeight}
          width={width}
          offset={transcriptScrollOffset}
          onMaximumOffsetChange={updateTranscriptMaximumOffset}
          theme={theme}
          locale={locale}
          backButton={transcriptScrollOffset > 0}
        />
      )}
      {panelNoticeVisible ? (
        <Text dimColor>{fitDisplayText(notice.split('\n')[0] ?? '', Math.max(1, width - 2))}</Text>
      ) : null}
      {palette !== null && !panelOpen ? (
        <CommandPaletteView
          matches={palette}
          selectedIndex={paletteSelectedIndex}
          width={width - 2}
          height={Math.max(1, paletteH)}
          locale={locale}
        />
      ) : null}
      {takeoverH > 0 ? (
        <Takeover
          snapshot={snapshot}
          approvalSel={approvalSel}
          questionIndex={questionIndex}
          questionSel={questionSel}
          questionText={questionText}
          width={width}
          height={takeoverH}
          locale={locale}
        />
      ) : null}
      <PermissionBar snapshot={snapshot} width={width} locale={locale} theme={theme} />
      <Composer
        draft={composerDraft}
        onDraftChange={pluginEdit !== null
          ? setPluginEditText
          : settingsEdit !== null
            ? setSettingsEditText
            : (value: string) => {
              // Every keystroke clears a stale picker dismissal so the
              // palette can never stay suppressed after an Escape, and
              // edits a recalled history line (leaving history browsing).
              setPaletteDismissedInput(null)
              if (historyIndex !== -1) setHistoryIndex(-1)
              setDraft(value)
            }}
        onSubmit={submitComposer}
        disabled={pluginEdit !== null || settingsEdit !== null
          ? false
          : (pendingApproval !== null || pendingQuestion !== null || panelOpen)}
        focused={composerFocused}
        width={width}
        placeholder={pluginEdit !== null
          ? (pluginEdit.kind === 'secret' ? copy.secretPlaceholder : pluginEdit.kind === 'number' ? copy.numberPlaceholder : copy.stringPlaceholder)
          : settingsEdit !== null ? copy.credentialPlaceholder : copy.placeholder}
        reserveKeys={reserveSelectionKeys}
        theme={theme}
        {...(pluginEdit?.kind === 'secret' ? { mask: '•' } : {})}
      />
      <StatusBar
        snapshot={snapshot}
        width={width}
        panelOpen={panelOpen}
        scrollOffset={transcriptScrollOffset}
        selectionHint={selectionHint}
        locale={locale}
        theme={theme}
      />
    </Box>
  )
}

/**
 * Mount the Ink 7 app in the alternate screen and resolve when it exits
 * (user command or Ctrl+C). Ink owns raw mode, the alternate screen, and the
 * cursor position.
 * @param store - the UI store.
 * @param host - submit/cancel/exit/answer callbacks.
 */
export async function runInk(store: TuiStore, host: TuiHost): Promise<void> {
  const instance = render(
    <App store={store} host={host} />,
    { alternateScreen: true, exitOnCtrlC: false, patchConsole: true },
  )
  try {
    await instance.waitUntilExit()
  } catch {
    // Ink teardown failures must not block the exit request.
  } finally {
    try { instance.unmount() } catch {}
  }
  host.exit()
}
