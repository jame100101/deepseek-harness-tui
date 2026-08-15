/**
 * Ground-truth render tests against the Ink 7 App: the root Box fills the
 * terminal (so Ink always takes its whole-screen clear path and interleaved
 * cursor writes can never corrupt the frame), Ink's OWN cursor suffix lands
 * on the composer caret (no manual CUP writes anywhere), wheel reports fed
 * through Ink's input stream drive the DamnatioX scroll semantics, and the
 * screen stays duplicate-free under streaming plus rapid wheel scrolling.
 */

import { Writable, PassThrough } from 'node:stream'
import { createElement } from 'react'
import { describe, expect, it, afterEach } from 'vitest'
import { render } from 'ink'
import stringWidth from 'string-width'
import { App, brandGlyph, permissionColor, permissionLabel, thinkingShimmerHex, thinkingShimmerLevel, traceLineColor } from '../src/render'
import type { TuiHost } from '../src/render'
import { createTuiStore } from '../src/store'
import type { TuiStore } from '../src/store'
import type { TuiNode } from '../src/types'

const COLUMNS = 100
const ROWS = 30

/** A Writable that records every byte written, with terminal dimensions. */
class Capture extends Writable {
  output = ''
  columns = COLUMNS
  rows = ROWS
  isTTY = true
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += String(chunk)
    callback()
  }
}

afterEach(() => {
  process.stdout.write = originalWrite
})

const originalWrite = process.stdout.write

/** Strip ANSI escapes so rendered rows can be indexed. */
function plain(output: string): string[] {
  return output
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .split('\n')
}

/** The last frame's rows (each frame starts with the header title). */
function lastFrameLines(output: string): string[] {
  const marker = 'DSH-TUI'
  const index = output.lastIndexOf(marker)
  if (index === -1) throw new Error(`header not found in ${JSON.stringify(output.slice(0, 400))}`)
  return plain(output.slice(index))
}

/** Number of rendered rows in a frame (a trailing newline adds one entry). */
function frameRows(lines: string[]): number {
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/** Ink's last cursor suffix: cursorUp(n) + cursorTo(x) + showCursor. */
function lastCursorSuffix(output: string): { moveUp: number; column: number } {
  const matches = [...output.matchAll(/\x1b\[(\d+)A\x1b\[(\d+)G\x1b\[\?25h/g)]
  const last = matches[matches.length - 1]
  if (last === undefined) throw new Error('no cursor suffix emitted')
  return { moveUp: Number(last[1]), column: Number(last[2]) }
}

/**
 * A minimal terminal-screen emulator: applies Ink's output stream the way a
 * real terminal would (clear screen, erase lines, cursor moves, text) so
 * residue from a wrong erase count becomes visible as duplicated rows —
 * exactly what `lastFrameLines` cannot see.
 */
class Screen {
  rows: string[][]
  x = 0
  y = 0

  constructor(public readonly columns: number, public readonly height: number) {
    this.rows = Array.from({ length: height }, () => Array.from({ length: columns }, () => ' '))
  }

  apply(chunk: string): void {
    let index = 0
    while (index < chunk.length) {
      const code = chunk.charCodeAt(index)
      if (code === 0x1b && chunk[index + 1] === '[') {
        const match = /^\x1b\[([0-9;?]*)([a-zA-Z])/.exec(chunk.slice(index))
        if (match === null) {
          index += 1
          continue
        }
        const params = (match[1] ?? '').split(';').map(value => Number.parseInt(value, 10))
        const final = match[2] ?? ''
        index += match[0].length
        switch (final) {
          case 'J':
            if (params[0] === 2 || params[0] === 3) {
              for (const row of this.rows) row.fill(' ')
            }
            break
          case 'K':
            this.rows[this.y]?.fill(' ')
            break
          case 'A':
            this.y = Math.max(0, this.y - (params[0] || 1))
            break
          case 'B':
            this.y = Math.min(this.height - 1, this.y + (params[0] || 1))
            break
          case 'C':
            this.x = Math.min(this.columns - 1, this.x + (params[0] || 1))
            break
          case 'D':
            this.x = Math.max(0, this.x - (params[0] || 1))
            break
          case 'G':
            this.x = Math.max(0, Math.min(this.columns - 1, (params[0] || 1) - 1))
            break
          case 'd':
            this.y = Math.max(0, Math.min(this.height - 1, (params[0] || 1) - 1))
            break
          case 'H':
          case 'f':
            this.y = Math.max(0, Math.min(this.height - 1, (params[0] || 1) - 1))
            this.x = Math.max(0, Math.min(this.columns - 1, (params[1] || 1) - 1))
            break
          default:
            break
        }
        continue
      }
      if (code === 0x1b) {
        index += 2
        continue
      }
      const character = chunk[index] ?? ''
      index += 1
      if (character === '\n') {
        this.y = Math.min(this.height - 1, this.y + 1)
        this.x = 0
        continue
      }
      if (character === '\r') {
        this.x = 0
        continue
      }
      if (character.charCodeAt(0) >= 0x20) {
        const row = this.rows[this.y]
        if (row !== undefined) row[this.x] = character
        this.x += 1
        if (this.x >= this.columns) {
          this.x = 0
          this.y = Math.min(this.height - 1, this.y + 1)
        }
      }
    }
  }

  /** Visible rows, trimmed of trailing spaces. */
  lines(): string[] {
    return this.rows.map(row => row.join('').replace(/\s+$/, ''))
  }
}

/** 1-based row of the composer input line in the last frame. */
function composerInputRow(lines: string[]): number {
  const index = lines.findIndex(line => line.trimStart().startsWith('›'))
  if (index === -1) throw new Error(`composer input row not found in ${JSON.stringify(lines.slice(-12))}`)
  return index + 1
}

interface Mounted {
  store: TuiStore
  capture: Capture
  stdin: ReturnType<typeof fakeStdin>
  unmount: () => void
  /** Write input, then settle React effects and Ink's frame write. */
  type(text: string): Promise<void>
}

function fakeStdin(): PassThrough & { isTTY: boolean; setRawMode(mode: boolean): unknown; ref(): void; unref(): void } {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode(mode: boolean): unknown
    ref(): void
    unref(): void
  }
  stream.isTTY = true
  stream.setRawMode = (mode: boolean) => mode
  stream.ref = () => {}
  stream.unref = () => {}
  return stream
}

async function mount(nodes: readonly TuiNode[] = [], hostOverrides: Partial<TuiHost> = {}): Promise<Mounted> {
  const capture = new Capture()
  const foldStats = {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, stepsWithTtft: 0, decodeMs: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    contextWindow: 0,
  }
  const store = createTuiStore({
    version: 0,
    nodes,
    trace: [],
    todos: [],
    stats: foldStats,
    live: null,
    busy: false,
    model: 'deepseek-v4-pro',
    sessionId: 'session-abc12345',
    cwd: 'D:\\work',
    pendingApproval: null,
    pendingQuestion: null,
    commands: [],
    models: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', label: 'deepseek-v4-pro' }],
    sessions: [],
    queued: [],
    settings: {
      general: { busyEnter: 'queue', thinking: 'collapsed', theme: 'dark', locale: 'zh' },
      models: { providers: [{ provider: 'deepseek-official', models: [{ id: 'deepseek-v4-pro' }] }], credentials: [] },
      plugins: [],
      configs: {},
      inventory: { namespaces: [], credentials: [], inspectProviders: 0 },
    },
    jobs: [],
    subagents: [],
    workflows: [],
    feedback: new Map(),
    plan: { active: false, pending: false },
    goal: null,
    reasoning: { effort: undefined, levels: [] },
    attachmentCount: 0,
    compaction: false,
    sandbox: 'read-only',
    occupancy: null,
  })
  const host: TuiHost = {
    submit: () => {},
    cancel: () => {},
    exit: () => {},
    newSession: () => {},
    selectModel: () => {},
    setEffort: () => {},
    cycleSandbox: () => 'read-only',
    togglePlugin: () => Promise.resolve({ enabled: true }),
    approve: () => {},
    answerQuestion: () => {},
    updateSetting: () => Promise.resolve(),
    setCredential: () => Promise.resolve(),
    unsetCredential: () => Promise.resolve(),
    refreshPanels: () => {},
    killJob: () => {},
    rateMessage: () => Promise.resolve(null),
    resumeSession: () => Promise.resolve(null),
    updatePluginConfig: () => Promise.resolve(null),
    renameSession: () => Promise.resolve(null),
    changeWorkspace: () => Promise.resolve(null),
    attachFile: () => Promise.resolve(null),
    forkSession: () => Promise.resolve(null),
    ...hostOverrides,
  }
  const stdin = fakeStdin()
  const instance = render(
    createElement(App, { store, host }),
    { exitOnCtrlC: false, patchConsole: false, alternateScreen: false, stdout: capture as never, stdin: stdin as never },
  )
  // Ink 7 probes the kitty keyboard protocol for the first ~200ms after
  // mount (a 'data' listener swallows input during that window); settle past
  // it before driving keys, exactly like a real user's first keystroke.
  const settle = async (): Promise<void> => { await new Promise<void>(resolve => setTimeout(resolve, 320)) }
  await settle()
  return { store, capture, stdin, unmount: () => instance.unmount(), type: async (text) => { stdin.write(text); await settle() } }
}

describe('Ink 7 full-screen render', () => {
  it('fills the terminal exactly and anchors the caret through Ink’s own cursor suffix', async () => {
    const { capture, unmount, type } = await mount()
    try {
      const lines = lastFrameLines(capture.output)
      expect(frameRows(lines)).toBe(ROWS)
      expect(lines.some(line => line.includes('dsh-tui v0.0.13 · DeepSeek Harness'))).toBe(true) // welcome panel
      expect(lines.some(line => line.includes('Session: session-abc12345'))).toBe(true) // full session id
      // A fullscreen frame writes NO trailing newline, so after the write the
      // terminal cursor rests ON the last row; Ink's suffix counts from one
      // line below it (`moveUp = visibleLineCount - y`). The renderer's +1
      // compensation must land the caret exactly on the composer input row:
      // starting row frameRows - 1, minus the suffix's cursorUp count.
      const suffix = lastCursorSuffix(capture.output)
      const inputRow = composerInputRow(lines)
      expect(frameRows(lines) - 1 - suffix.moveUp).toBe(inputRow - 1)
      // ansi-escapes' cursorTo is 1-based (it emits x + 1): the caret at
      // 0-based column 3 (after the '› ' prompt) renders as column 4.
      expect(suffix.column).toBe(4)
      // Typing moves the caret with the text (after 'ab': 0-based 5 → 6).
      await type('ab')
      const typed = lastCursorSuffix(capture.output)
      expect(typed.column).toBe(6)
    } finally {
      unmount()
    }
  })

  it('shows the slash picker and dismisses it with Escape', async () => {
    const { capture, unmount, type } = await mount()
    try {
      await type('/')
      let lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('命令（↑↓ 选择'))).toBe(true)
      await type('\x1b')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('命令（↑↓ 选择'))).toBe(false)
    } finally {
      unmount()
    }
  })

  it('keeps the picker open while a turn streams and moves with arrow keys', async () => {
    const { store, capture, unmount, type } = await mount()
    try {
      const snapshot = store.getSnapshot()
      store.set({ ...snapshot, version: snapshot.version + 1, busy: true, live: { text: '正在流式回答', think: '思考中', thinkSince: Date.now() } })
      await type('/')
      let lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('命令（↑↓ 选择'))).toBe(true)
      expect(lines.some(line => line.includes('▸ /help'))).toBe(true)
      await type('\x1b[B')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('命令（↑↓ 选择'))).toBe(true)
      expect(lines.some(line => line.includes('▸ /clear'))).toBe(true)
      expect(lines.some(line => line.includes('▸ /help'))).toBe(false)
    } finally {
      unmount()
    }
  })

  it('survives a split arrow sequence: a flushed lone ESC must not wipe the draft or the picker', async () => {
    const { capture, unmount, stdin } = await mount()
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      stdin.write('/')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      let lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('命令（↑↓ 选择'))).toBe(true)
      // The ESC head of a split `\x1b[B` arrives alone (Ink flushes pending
      // escapes after 20ms); the tail lands later, inside the 60ms confirm
      // window. The phantom ESC must neither clear the draft nor dismiss the
      // picker, and the tail must act as a down-arrow.
      stdin.write('\x1b')
      await new Promise<void>(resolve => setTimeout(resolve, 40))
      stdin.write('[B')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('命令（↑↓ 选择'))).toBe(true)
      expect(lines.some(line => line.includes('▸ /clear'))).toBe(true)
      expect(lines.some(line => line.includes('› /'))).toBe(true)
      // No stray CSI tail leaked into the composer as text.
      expect(lines.some(line => line.includes('[B'))).toBe(false)
    } finally {
      unmount()
    }
  })

  it('scrolls the transcript with wheel reports using the DamnatioX semantics', async () => {
    const nodes: TuiNode[] = Array.from({ length: 40 }, (_, index) => ({
      kind: 'user', id: index, text: `第${index}行`,
    }))
    const { capture, unmount, type } = await mount(nodes)
    try {
      let lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('▼ 回到底部'))).toBe(false)
      // One wheel-up tick hides 3 lines and pins the back button.
      await type('\x1b[<64;10;5M')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('▼ 回到底部'))).toBe(true)
      expect(lines.some(line => line.includes('▸ 第39行'))).toBe(false)
      // A wheel-down tick brings the newest lines back.
      await type('\x1b[<65;10;5M')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('▼ 回到底部'))).toBe(false)
      expect(lines.some(line => line.includes('▸ 第39行'))).toBe(true)
      // PgDn keeps working as the follow-mode accelerator.
      await type('\x1b[<64;10;5M')
      await type('\x1b[6~')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('▼ 回到底部'))).toBe(false)
    } finally {
      unmount()
    }
  })

  it('opens the settings panel from the slash picker and exits with q', async () => {
    const { capture, unmount, type } = await mount()
    try {
      // A real terminal delivers text and Enter as separate stdin chunks.
      await type('/settings')
      await type('\r')
      let lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('常规 General'))).toBe(true)
      await type('q')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('常规 General'))).toBe(false)
    } finally {
      unmount()
    }
  })

  it('keeps the frame clean under streaming plus rapid wheel scrolling', async () => {
    const nodes: TuiNode[] = Array.from({ length: 30 }, (_, index) => ({
      kind: 'user', id: index, text: `第${index}行`,
    }))
    const { store, capture, unmount, type } = await mount(nodes)
    try {
      // Simulate a streaming turn: the live buffer grows tick by tick.
      for (let tick = 0; tick < 20; tick++) {
        const snapshot = store.getSnapshot()
        store.set({
          ...snapshot,
          version: snapshot.version + 1,
          busy: true,
          live: { text: `回答内容 ${tick}`, think: `思考内容 ${tick}\n${'x'.repeat(tick)}`, thinkSince: Date.now() - tick * 100 },
        })
        await new Promise<void>(resolve => setTimeout(resolve, 25))
      }
      // Rapid wheel scrolling in both directions without settling between —
      // real wheels emit several reports per notch, so drive many.
      for (let index = 0; index < 60; index++) void type('\x1b[<64;10;5M')
      for (let index = 0; index < 60; index++) void type('\x1b[<65;10;5M')
      // The turn ends while the user is still scrolled up.
      {
        const snapshot = store.getSnapshot()
        store.set({ ...snapshot, version: snapshot.version + 1, busy: false, live: null })
      }
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      const lines = lastFrameLines(capture.output)
      expect(frameRows(lines)).toBe(ROWS)
      // The live Thinking spinner appears exactly once, not once per tick.
      const thinkingRows = lines.filter(line => line.includes('Thinking'))
      expect(thinkingRows.length).toBeLessThanOrEqual(2)
      // Each transcript line appears at most once in the frame (separators
      // and blank rows are exempt — three identical '─' rules are expected).
      const seen = new Map<string, number>()
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '' || /^─+$/.test(trimmed)) continue
        const count = (seen.get(line) ?? 0) + 1
        seen.set(line, count)
        expect(count).toBe(1)
      }
      // A real terminal applies the whole stream sequentially; the screen
      // emulator must show the same clean frame (this catches erase-count
      // residue that the raw last frame cannot see).
      const screen = new Screen(COLUMNS, ROWS)
      screen.apply(capture.output)
      const screenLines = screen.lines()
      expect(screenLines.filter(line => line.includes('Thinking')).length).toBeLessThanOrEqual(2)
      const screenSeen = new Map<string, number>()
      for (const line of screenLines) {
        const trimmed = line.trim()
        if (trimmed === '' || /^─+$/.test(trimmed)) continue
        const count = (screenSeen.get(line) ?? 0) + 1
        screenSeen.set(line, count)
        expect(count).toBe(1)
      }
    } finally {
      unmount()
    }
  })

  it('walks selection onto assistant messages and rates them with g/b', async () => {
    const rates: { messageId: string; rating: 'positive' | 'negative' }[] = []
    const nodes: TuiNode[] = [
      { kind: 'user', id: 1, text: '你好' },
      { kind: 'assistant', id: 2, text: '你好！', messageId: 'a1' },
    ]
    const { capture, unmount, type } = await mount(nodes, {
      rateMessage: async (messageId, rating) => {
        rates.push({ messageId, rating })
        return null
      },
    })
    try {
      // Tab enters selection mode on the LAST node (the assistant row here);
      // ↑/↓ then walk every visible row, not only collapsible ones.
      await type('\t')
      let lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('» ● 你好！'))).toBe(true)
      expect(lines.some(line => line.includes('g 赞 · b 踩'))).toBe(true)
      // ↑ walks up to the user row, ↓ back down to the assistant.
      await type('\x1b[A')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('» ▸ 你好'))).toBe(true)
      await type('\x1b[B')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('» ● 你好！'))).toBe(true)
      await type('g')
      expect(rates).toEqual([{ messageId: 'a1', rating: 'positive' }])
      await type('b')
      expect(rates).toEqual([
        { messageId: 'a1', rating: 'positive' },
        { messageId: 'a1', rating: 'negative' },
      ])
      lines = lastFrameLines(capture.output)
      // Typing while the composer is empty never pollutes the draft.
      expect(lines.some(line => line.trimStart().startsWith('› g'))).toBe(false)
      expect(lines.some(line => line.trimStart().startsWith('› b'))).toBe(false)
    } finally {
      unmount()
    }
  })

  it('opens the sessions panel with persisted rows and resumes on Enter', async () => {
    const resumed: string[] = []
    const { store, capture, unmount, type } = await mount([{ kind: 'user', id: 1, text: 'hi' }], {
      resumeSession: async (id) => {
        resumed.push(id)
        return null
      },
    })
    try {
      const snapshot = store.getSnapshot()
      store.set({
        ...snapshot,
        version: snapshot.version + 1,
        sessions: [
          { id: 'session-live0001', model: 'deepseek-v4-pro', status: 'running' },
          { id: 'session-old0001', model: '', status: 'persisted', title: '修好所有测试', live: false, persisted: true, createdAt: 1 },
        ],
      })
      await type('/sessions')
      await type('\r')
      let lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('活动会话 / 持久化会话'))).toBe(true)
      expect(lines.some(line => line.includes('session-old0') && line.includes('修好所有测试'))).toBe(true)
      // ↓ onto the persisted row (row 2: head + live row above it), Enter resumes.
      await type('\x1b[B')
      await type('\x1b[B')
      await type('\r')
      expect(resumed).toEqual(['session-old0001'])
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('已恢复会话 session-old0001'))).toBe(true)
    } finally {
      unmount()
    }
  })

  it('filters the sessions panel by the /sessions query argument', async () => {
    const { store, capture, unmount, type } = await mount([{ kind: 'user', id: 1, text: 'hi' }])
    try {
      const snapshot = store.getSnapshot()
      store.set({
        ...snapshot,
        version: snapshot.version + 1,
        sessions: [
          { id: 'session-aaa00001', model: '', status: 'persisted', title: '重构计划', live: false, persisted: true, createdAt: 1 },
          { id: 'session-bbb00002', model: '', status: 'persisted', title: '修 bug', live: false, persisted: true, createdAt: 2 },
        ],
      })
      await type('/sessions 重构')
      await type('\r')
      const lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('过滤 "重构"'))).toBe(true)
      expect(lines.some(line => line.includes('session-aaa0'))).toBe(true)
      expect(lines.some(line => line.includes('session-bbb0'))).toBe(false)
    } finally {
      unmount()
    }
  })

  it('routes /rename /workspace /attach /fork to the host and shows the attachment dock', async () => {
    const calls: string[] = []
    const { store, capture, unmount, type } = await mount([{ kind: 'user', id: 1, text: 'hi' }], {
      renameSession: async (title) => { calls.push(`rename:${title}`); return null },
      changeWorkspace: async (path) => { calls.push(`workspace:${path}`); return null },
      attachFile: async (path) => { calls.push(`attach:${path}`); return null },
      forkSession: async () => { calls.push('fork'); return null },
    })
    try {
      await type('/rename 新标题')
      await type('\r')
      await type('/workspace D:\\tmp')
      await type('\r')
      await type('/attach pic.png')
      await type('\r')
      await type('/fork')
      await type('\r')
      expect(calls).toEqual(['rename:新标题', 'workspace:D:\\tmp', 'attach:pic.png', 'fork'])
      const snapshot = store.getSnapshot()
      store.set({ ...snapshot, version: snapshot.version + 1, attachmentCount: 2 })
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      const lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('2 张图片附件'))).toBe(true)
    } finally {
      unmount()
    }
  })

  it('colors the trajectory view: model blue, tools red, user cyan', async () => {
    const { store, capture, unmount, type } = await mount([{ kind: 'user', id: 1, text: 'hi' }])
    try {
      const snapshot = store.getSnapshot()
      store.set({
        ...snapshot,
        version: snapshot.version + 1,
        trace: [
          { id: 1, text: 'turn 1 start' },
          { id: 2, text: 'user (user): hi' },
          { id: 3, text: 'tool read' },
          { id: 4, text: 'result done' },
          { id: 5, text: 'assistant (12 chars)' },
        ],
      })
      await type('/trajectory')
      await type('\r')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      const lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('· assistant'))).toBe(true)
      expect(lines.some(line => line.includes('· tool read'))).toBe(true)
      // The color mapping itself is a pure function (chalk strips ANSI codes
      // when the harness stdout is not a TTY, so the raw stream cannot see
      // them): model blue, tool activity red, user cyan, structure dim.
      expect(traceLineColor('· assistant (12 chars)')).toBe('blue')
      expect(traceLineColor('· tool read')).toBe('red')
      expect(traceLineColor('· result done')).toBe('red')
      expect(traceLineColor('· user (user): hi')).toBe('cyan')
      expect(traceLineColor('· turn 1 start')).toBeUndefined()
    } finally {
      unmount()
    }
  })

  it('draws a live compacting gradient row while a compaction runs', async () => {
    const { store, capture, unmount } = await mount([{ kind: 'user', id: 1, text: 'hi' }])
    try {
      const snapshot = store.getSnapshot()
      store.set({ ...snapshot, version: snapshot.version + 1, compaction: true })
      await new Promise<void>(resolve => setTimeout(resolve, 400))
      const lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('compacting…'))).toBe(true)
      // Settling the run removes the live row and lands the status row.
      const settled = store.getSnapshot()
      store.set({ ...settled, version: settled.version + 1, compaction: false })
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      const after = lastFrameLines(capture.output)
      expect(after.some(line => line.includes('compacting…'))).toBe(false)
    } finally {
      unmount()
    }
  })

  it('renders the plan indicator and the goal dock from the snapshot', async () => {
    const { store, capture, unmount, type } = await mount([{ kind: 'user', id: 1, text: 'hi' }])
    try {
      const snapshot = store.getSnapshot()
      store.set({
        ...snapshot,
        version: snapshot.version + 1,
        plan: { active: true, pending: false },
        goal: {
          objective: '修好所有测试', phase: 'active', revision: 1, roundsStarted: 0,
          maxGoalRounds: 12, createdAt: 1, updatedAt: 1,
        },
      })
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      const lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('◈ plan'))).toBe(true)
      expect(lines.some(line => line.includes('◈ goal [进行中] · round 0/12 · 修好所有测试'))).toBe(true)
      // /goal opens the full detail notice (Enter as its own chunk).
      await type('/goal')
      await type('\r')
      const notice = lastFrameLines(capture.output)
      expect(notice.some(line => line.includes('目标：修好所有测试'))).toBe(true)
    } finally {
      unmount()
    }
  })

  it('wraps an overflowing composer draft onto further lines instead of truncating', async () => {
    const { capture, unmount, type } = await mount()
    try {
      await type('a'.repeat(150))
      const lines = lastFrameLines(capture.output)
      // 150 cells in a 96-cell input wrap into TWO lines; a truncated
      // single-line input could only ever render one row of ≥40 `a`s.
      expect(lines.filter(line => line.includes('a'.repeat(40))).length).toBeGreaterThanOrEqual(2)
      expect(lines.some(line => line.includes('a'.repeat(40)) && line.trimStart().startsWith('›'))).toBe(true)
    } finally {
      unmount()
    }
  })

  it('shows the reasoning effort in the status bar and the colored permission above the composer', async () => {
    const { store, capture, unmount } = await mount()
    try {
      const snapshot = store.getSnapshot()
      store.set({
        ...snapshot,
        version: snapshot.version + 1,
        reasoning: { effort: 'high', levels: ['low', 'medium', 'high', 'max'] },
        sandbox: 'workspace-write',
      })
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      const lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('effort high'))).toBe(true)
      // The permission chip lives on its own row above the composer with the
      // Shift+Tab hint — never in the status bar.
      const chip = lines.find(line => line.includes('权限 workspace write'))
      expect(chip).toBeDefined()
      expect(chip).toContain('Shift+Tab 切换')
      expect(lines.some(line => line.includes('权限 workspace write') && line.includes('Σ'))).toBe(false)
      // The mode colors are pure mappings: white / yellow / red.
      expect(permissionLabel('read-only')).toBe('read only')
      expect(permissionLabel('workspace-write')).toBe('workspace write')
      expect(permissionLabel('danger-full-access')).toBe('full access')
      expect(permissionColor('read-only')).toBe('whiteBright')
      expect(permissionColor('workspace-write')).toBe('yellowBright')
      expect(permissionColor('danger-full-access')).toBe('redBright')
    } finally {
      unmount()
    }
  })

  it('cycles the file permission on Shift+Tab (one chunk and split ESC)', async () => {
    const cycled: string[] = []
    const { capture, unmount, type, stdin } = await mount([{ kind: 'user', id: 1, text: 'hi' }], {
      cycleSandbox: () => {
        cycled.push('cycle')
        return 'workspace-write'
      },
    })
    try {
      await type('\x1b[Z')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      expect(cycled).toEqual(['cycle'])
      // The pinned permission row is the feedback; no extra "权限 →" notice.
      const lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('权限 →'))).toBe(false)
      // The split form: ESC flushes early, the `[Z` tail lands inside the
      // arbiter window and re-synthesizes as shift+tab.
      stdin.write('\x1b')
      await new Promise<void>(resolve => setTimeout(resolve, 40))
      stdin.write('[Z')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      expect(cycled).toEqual(['cycle', 'cycle'])
      // No CSI tail leaked into the composer as text.
      expect(lastFrameLines(capture.output).some(line => line.includes('[Z'))).toBe(false)
    } finally {
      unmount()
    }
  })

  it('routes /effort off|high|max to the host and rejects other values', async () => {
    const efforts: (string | undefined)[] = []
    const { capture, unmount, type } = await mount([{ kind: 'user', id: 1, text: 'hi' }], {
      setEffort: (effort) => { efforts.push(effort) },
    })
    try {
      await type('/effort high')
      await type('\r')
      await type('/effort off')
      await type('\r')
      expect(efforts).toEqual(['high', undefined])
      let lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('推理等级 → off'))).toBe(true)
      await type('/effort low')
      await type('\r')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('用法：/effort off|high|max'))).toBe(true)
      expect(efforts).toEqual(['high', undefined])
    } finally {
      unmount()
    }
  })

  it('keeps the /sessions selection visible: the viewport follows the cursor', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `session-${String(index).padStart(4, '0')}`,
      model: '', status: 'persisted', live: false, persisted: true, createdAt: index,
    }))
    const { store, capture, unmount, type } = await mount([{ kind: 'user', id: 1, text: 'hi' }])
    try {
      const snapshot = store.getSnapshot()
      store.set({ ...snapshot, version: snapshot.version + 1, sessions: rows })
      await type('/sessions')
      await type('\r')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      // Walk the selection 25 rows down: without scroll-follow the selected
      // row would sit far below the 20-row panel window and stay invisible.
      for (let press = 0; press < 25; press += 1) {
        await type('\x1b[B')
      }
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      const lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('▸ ') && line.includes('session-0024'))).toBe(true)
      // Walking back up brings the head into view again.
      for (let press = 0; press < 25; press += 1) {
        await type('\x1b[A')
      }
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      const back = lastFrameLines(capture.output)
      expect(back.some(line => line.includes('▸ ') && line.includes('活动会话 / 持久化会话'))).toBe(true)
    } finally {
      unmount()
    }
  }, 60_000)

  it('recalls the previous and next inputs with ↑/↓ like cmd/PowerShell', async () => {
    const submissions: string[] = []
    const { capture, unmount, type } = await mount([], {
      submit: (text) => { submissions.push(text) },
    })
    try {
      await type('first task')
      await type('\r')
      await type('second task')
      await type('\r')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      // ↑ recalls the newest submission into the composer.
      await type('\x1b[A')
      let lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('› second task'))).toBe(true)
      // ↑ again goes one further back.
      await type('\x1b[A')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('› first task'))).toBe(true)
      // ↓ walks forward again; past the newest it restores the empty draft.
      await type('\x1b[B')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('› second task'))).toBe(true)
      await type('\x1b[B')
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('› second task'))).toBe(false)
      // The recalled line submits like any other input.
      await type('\x1b[A')
      await type('\r')
      expect(submissions).toEqual(['first task', 'second task', 'second task'])
    } finally {
      unmount()
    }
  }, 30_000)

  it('shows a floating back-to-bottom button when scrolled up and returns on click', async () => {
    const nodes: TuiNode[] = Array.from({ length: 40 }, (_, index) => ({
      kind: 'user', id: index, text: `第${index}行`,
    }))
    const { capture, unmount, type } = await mount(nodes)
    try {
      await type('\x1b[<64;10;5M')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      let lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('▼ 回到底部'))).toBe(true)
      expect(lines.some(line => line.includes('▸ 第39行'))).toBe(false)
      // The button pins to the last transcript row: 30-row terminal, 4-row
      // header, 20-row transcript → 1-based terminal row 24. A left-press
      // there returns to the newest lines.
      await type('\x1b[<0;5;24M')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('▼ 回到底部'))).toBe(false)
      expect(lines.some(line => line.includes('▸ 第39行'))).toBe(true)
    } finally {
      unmount()
    }
  }, 30_000)

  it('toggles a plugin switch on the plugins page through the host', async () => {
    const toggles: string[] = []
    const { store, capture, unmount, type } = await mount([{ kind: 'user', id: 1, text: 'hi' }], {
      togglePlugin: async (id) => {
        toggles.push(id)
        return { enabled: false }
      },
    })
    try {
      const snapshot = store.getSnapshot()
      store.set({
        ...snapshot,
        version: snapshot.version + 1,
        settings: snapshot.settings === null ? snapshot.settings : {
          ...snapshot.settings,
          plugins: [
            { id: 'storage', name: 'storage', enabled: true, loaded: true, namespace: 'storage' },
            { id: 'off', name: 'off', enabled: false, loaded: false },
          ],
        },
      })
      await type('/settings plugins')
      await type('\r')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      let lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('插件 Plugins') && line.includes('Enter 切换开关'))).toBe(true)
      expect(lines.some(line => line.includes('● storage'))).toBe(true)
      // ↓ onto the first plugin row, Enter toggles it through the host.
      await type('\x1b[B')
      await type('\r')
      expect(toggles).toEqual(['storage'])
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('storage → 已关闭'))).toBe(true)
      // `c` opens the plugin's config editor; `q` returns to the plugins list.
      await type('c')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('插件配置 · Enter 切换/编辑'))).toBe(true)
      await type('q')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('插件 Plugins'))).toBe(true)
    } finally {
      unmount()
    }
  }, 30_000)

  it('labels a settled Thinking row with its 0.1s-precision duration', async () => {
    const { capture, unmount } = await mount([{ kind: 'think', id: 1, text: 'reasoning here', durationMs: 3456 }])
    try {
      const lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('✓ Thinking 3.5s ▶'))).toBe(true)
    } finally {
      unmount()
    }
  })

  it('wraps the expanded Thinking body at word boundaries, not mid-word', async () => {
    const { store, capture, unmount } = await mount([{
      kind: 'think', id: 1, text: `${'x'.repeat(95)} hello world`, durationMs: 1,
    }])
    try {
      const snapshot = store.getSnapshot()
      store.set({
        ...snapshot,
        version: snapshot.version + 1,
        settings: snapshot.settings === null ? snapshot.settings : {
          ...snapshot.settings,
          general: { ...snapshot.settings.general, thinking: 'expanded' },
        },
      })
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      const lines = lastFrameLines(capture.output)
      // The word breaks only at spaces: 'hello world' stays whole on its
      // own row instead of splitting 'llo' off mid-word.
      expect(lines.some(line => line.includes('  │ hello world'))).toBe(true)
      expect(lines.some(line => line.includes('  │ llo'))).toBe(false)
    } finally {
      unmount()
    }
  })

  it('reflows to a shrunken terminal without rows bleeding into each other', async () => {
    const { capture, unmount, type } = await mount()
    try {
      capture.columns = 30
      capture.rows = 20
      capture.emit('resize')
      await new Promise<void>(resolve => setTimeout(resolve, 320))
      const lines = lastFrameLines(capture.output)
      expect(frameRows(lines)).toBe(20)
      // No rendered row may exceed the physical width — the wrap would push
      // its tail onto the next row (the overlap bug).
      for (const line of lines) {
        expect(stringWidth(line)).toBeLessThanOrEqual(30)
      }
      // The welcome panel's borders stay on one intact row each.
      expect(lines.some(line => line.trimStart().startsWith('┏') && line.trimEnd().endsWith('┓'))).toBe(true)
      expect(lines.some(line => line.trimStart().startsWith('┗') && line.trimEnd().endsWith('┛'))).toBe(true)
      // Typing '/' opens the palette; the palette must respect its height
      // budget so it can never overwrite the composer row below it, and the
      // composer row itself must show the draft.
      await type('/')
      const afterSlash = lastFrameLines(capture.output)
      const composerRows = afterSlash.filter(line => line.trimStart().startsWith('›'))
      expect(composerRows.length).toBeGreaterThan(0)
      expect(composerRows.at(-1)).toContain('/')
      // Budgeted rows: title + hint + (height - 2) items, clamped to the
      // available space above the fixed chrome.
      const fixed = 4 + 1 + 1 + 1 + 3
      const maxPalette = Math.max(0, 20 - fixed - 1)
      expect(afterSlash.filter(line => line.trimStart().startsWith('/') || line.includes('命令（')).length).toBeLessThanOrEqual(maxPalette)
    } finally {
      unmount()
    }
  })

  it('renders the Thinking shimmer with the original spinner glyph up front', async () => {
    const { store, capture, unmount } = await mount([{ kind: 'user', id: 1, text: 'hi' }])
    try {
      const snapshot = store.getSnapshot()
      store.set({
        ...snapshot,
        version: snapshot.version + 1,
        busy: true,
        live: { text: '', think: '正在推理', thinkSince: Date.now() },
      })
      await new Promise<void>(resolve => setTimeout(resolve, 400))
      const lines = lastFrameLines(capture.output)
      // The original spinning glyph leads the row; the shimmer rides the
      // " Thinking" letters behind it.
      expect(lines.some(line => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line) && line.includes('Thinking'))).toBe(true)
    } finally {
      unmount()
    }
  })

  it('sweeps the grayscale highlight window left to right with smooth falloff', () => {
    const length = 10
    // At phase 0 the window enters from the left: index 0 sits inside the
    // band, far indices stay at the medium-gray base.
    const at0 = Array.from({ length }, (_, index) => thinkingShimmerLevel(index, 0, length))
    expect(at0[0]).toBeGreaterThan(at0[5])
    expect(thinkingShimmerLevel(9, 0, length)).toBe(145)
    // The window center reaches near-white and the band is symmetric
    // around it: gray → lighter → white → lighter → gray.
    const centerPhase = 4 // center = phase % span - 4 = 0 → index 0 is the peak
    const band = Array.from({ length: 11 }, (_, index) => thinkingShimmerLevel(index - 5, centerPhase, length))
    expect(band[0]).toBe(145)
    expect(band[2]).toBeGreaterThan(band[0])
    expect(band[5]).toBe(255)
    expect(band[8]).toBeGreaterThan(band[10])
    expect(band[10]).toBe(145)
    // The peak sweeps right as the phase advances.
    const peakAt = (phase: number): number => {
      let best = 0
      for (let index = 0; index < length; index += 1) {
        if (thinkingShimmerLevel(index, phase, length) >= thinkingShimmerLevel(best, phase, length)) best = index
      }
      return best
    }
    expect(peakAt(4)).toBeLessThan(peakAt(10))
    // Grayscale hex encoding: readable base and peak.
    expect(thinkingShimmerHex(145)).toBe('#919191')
    expect(thinkingShimmerHex(255)).toBe('#ffffff')
  })

  it('picks the whale brand glyph only on width-correct terminals', () => {
    expect(brandGlyph({ WT_SESSION: 'x' })).toBe('🐋')
    expect(brandGlyph({ TERM: 'xterm-256color' })).toBe('🐋')
    expect(brandGlyph({ TERM: 'dumb' })).toBe('✦')
    // Legacy Windows conhost without a modern-terminal marker degrades.
    expect(brandGlyph({})).toBe('✦')
    // The header measures the brand by its real width either way.
    expect(stringWidth(`${brandGlyph({ WT_SESSION: 'x' })} DSH-TUI`)).toBe(10)
    expect(stringWidth(`${brandGlyph({})} DSH-TUI`)).toBe(9)
  })

  it('sets the whale tab title on mount and keeps the frame clean', async () => {
    const { capture, unmount } = await mount()
    try {
      expect(capture.output).toContain('\x1b]0;🐋 DeepSeek Harness\x07')
      expect(capture.output).toContain('\x1b[21t')
      const lines = lastFrameLines(capture.output)
      expect(lines.some(line => line.includes('DSH-TUI'))).toBe(true)
    } finally {
      unmount()
    }
  })
})
