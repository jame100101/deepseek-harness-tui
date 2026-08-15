/**
 * Mouse-input helpers, ported from the DamnatioX TypeScript TUI: Ink 7
 * delivers raw SGR mouse reports through `useInput` as input strings, so the
 * surface enables wheel + button-motion tracking itself, parses wheel and
 * drag reports from input, and strips stray reports from typed/pasted text.
 * @module @deepseek-ai/dsh-tui/src/mouse
 */

/**
 * Enable basic (X10) + button-motion (1002) + SGR (1006) mouse tracking.
 * The motion mode streams drag reports while a button stays pressed, which
 * the right-edge scrollbar consumes as drag-to-scroll; terminals without
 * 1002 support ignore the mode and the scrollbar still jumps on plain clicks.
 */
export const ENABLE_WHEEL_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h'
/** Disable mouse tracking again (exit path). */
export const DISABLE_WHEEL_MOUSE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l'
/** Lines one wheel tick scrolls the transcript by. */
export const MOUSE_WHEEL_LINES = 3

/** The direction one wheel tick asks the transcript to scroll. */
export type MouseWheelDirection = 'up' | 'down'

/** One parsed SGR mouse report. */
export interface MouseReport {
  button: number
  column: number
  row: number
  action: 'press' | 'release'
}

const SGR_MOUSE_REPORT = /^\x1b?\[<(\d+);(\d+);(\d+)([mM])$/u

/**
 * Parse one SGR mouse report (`ESC[<b;x;yM` / `…m`).
 * @param input - the raw input string.
 * @returns the report, or null when the input is not a valid mouse report.
 */
export function parseMouseReport(input: string): MouseReport | null {
  const match = SGR_MOUSE_REPORT.exec(input)
  if (match === null) return null
  const button = Number.parseInt(match[1] ?? '', 10)
  const column = Number.parseInt(match[2] ?? '', 10)
  const row = Number.parseInt(match[3] ?? '', 10)
  if (
    !Number.isInteger(button) ||
    !Number.isInteger(column) ||
    !Number.isInteger(row) ||
    column < 1 ||
    row < 1
  ) {
    return null
  }
  return {
    button,
    column,
    row,
    action: match[4] === 'M' ? 'press' : 'release',
  }
}

/**
 * Parse one wheel tick out of a mouse report: button 64/65 with the motion
 * bit (0x40) set maps to up (scroll toward older lines) / down.
 * @param input - the raw input string.
 * @returns the wheel direction, or null for non-wheel input.
 */
export function parseMouseWheel(input: string): MouseWheelDirection | null {
  const report = parseMouseReport(input)
  if (report === null) return null
  if ((report.button & 64) === 0) return null
  return (report.button & 1) === 0 ? 'up' : 'down'
}

/**
 * Remove mouse reports from typed or pasted text.
 * @param input - the raw text.
 * @returns the text without mouse reports.
 */
export function stripMouseReports(input: string): string {
  return input.replaceAll(/\x1b?\[<\d+;\d+;\d+[mM]/gu, '')
}

/**
 * Compute the next transcript scroll offset for one wheel tick. The offset
 * counts hidden lines from the BOTTOM: up scrolls toward older lines (offset
 * grows), down toward the newest (offset shrinks to 0 = follow mode).
 * @param currentOffset - the current offset.
 * @param maximumOffset - the current maximum offset.
 * @param direction - the wheel direction.
 * @param lines - lines per tick (defaults to {@link MOUSE_WHEEL_LINES}).
 * @returns the clamped next offset.
 */
export function scrollOffsetForWheel(
  currentOffset: number,
  maximumOffset: number,
  direction: MouseWheelDirection,
  lines = MOUSE_WHEEL_LINES,
): number {
  const maximum = Math.max(0, Math.floor(maximumOffset))
  const current = Math.min(maximum, Math.max(0, Math.floor(currentOffset)))
  const distance = Math.max(1, Math.floor(lines))
  return direction === 'up'
    ? Math.min(maximum, current + distance)
    : Math.max(0, current - distance)
}
