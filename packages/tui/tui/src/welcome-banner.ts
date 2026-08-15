/**
 * The first-load welcome banner: the DeepSeek whale pixel art (an immutable
 * literal, never generated at runtime) over a block-style 3D `DEEPSEEK
 * HARNESS` title with a bottom-right shadow. Both center horizontally; the
 * whole block degrades instead of wrapping when the terminal is too narrow
 * or short, so the art can never break apart.
 * @module @deepseek-ai/dsh-tui/src/welcome-banner
 */

import stringWidth from 'string-width'

/** The DeepSeek whale pixel art — verbatim, do not reformat. */
export const WHALE_ART: readonly string[] = [
  '              ⣀⣀⣀⡀       ⣤⡀',
  '      ⢀⣠⣴⣿⣿⣿⣿⣶⣤⣀      ⢰⣿⣷⣤⣄      ⣠⣤',
  '    ⢀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣄     ⢿⣿⣿⣿⣶⣤⣴⣿⣿⡟',
  '   ⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦     ⠻⣿⣿⣿⣿⣿⡿⠋',
  '  ⣿⣿⠋⠉⠉⠛⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣦⣤⣤⣿⣿⣿⠋',
  '  ⣿⣿          ⠙⣿⣿⣿⣿⣿⣦⠈⢿⣿⣿⣿⣿⡿',
  '  ⢿⣿⣧           ⠹⣿⣿⣿⣿⣿⣄⣸⣿⣿⣿⣿⠃',
  '  ⠘⣿⣿⣦           ⠈⢿⣿⣿⣿⣿⣿⣿⣿⣿⠏',
  '   ⠙⣿⣿⣷⣄       ⣤⣄   ⠻⣿⣿⣿⣿⣿⡿⠃',
  '     ⠻⣿⣿⣷⣤⣀⣀⣀⣸⣿⣿⣶⣄   ⠙⠿⣿⣿⣤⣀',
  '       ⠙⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡶⠞⠋',
  '           ⠉⠉⠛⠛⠛⠛⠉',
]

/** DeepSeek brand blue for the whale (ANSI TrueColor). */
export const WHALE_COLOR = '#4D6BFE'

/** Bright light-blue main glyphs of the 3D title. */
export const TITLE_MAIN_COLOR = '#7C9BFF'

/** Darker blue-gray shadow layer of the 3D title. */
export const TITLE_SHADOW_COLOR = '#2B3A66'

/** One colored segment of a banner row. */
export interface BannerRun {
  text: string
  color: string
}

/** One precomputed banner row. */
export interface BannerRow {
  runs: BannerRun[]
  /** The row's cell width (for centering). */
  width: number
}

/** 5x5 block glyphs for the title's letters. */
const FONT: Record<string, readonly string[]> = {
  D: ['████ ', '█  █ ', '█  █ ', '█  █ ', '████ '],
  E: ['████ ', '█    ', '████ ', '█    ', '████ '],
  P: ['████ ', '█  █ ', '████ ', '█    ', '█    '],
  S: ['████ ', '█    ', '████ ', '    █', '████ '],
  K: ['█  █ ', '█ █  ', '██   ', '█ █  ', '█  █ '],
  H: ['█  █ ', '█  █ ', '████ ', '█  █ ', '█  █ '],
  A: [' ██  ', '█  █ ', '████ ', '█  █ ', '█  █ '],
  R: ['████ ', '█  █ ', '████ ', '█ █  ', '█  █ '],
  N: ['█  █ ', '██ █ ', '█ ██ ', '█  █ ', '█  █ '],
}

const LETTER_WIDTH = 5
const LETTER_GAP = 1
const SPACE_WIDTH = 3

/**
 * Precompute the 3D title: the 5-row block text with its shadow layer
 * offset one row down and one column right. A shadow cell renders only
 * where the main glyph does not already paint. Deterministic module-scope
 * build — no external commands, no runtime generation.
 * @param text - the title text.
 * @returns the precomputed rows.
 */
function buildTitleRows(text: string): BannerRow[] {
  const glyphs = [...text].map(character => FONT[character] ?? null)
  const totalWidth = glyphs.reduce((width, glyph) => width + (glyph === null ? SPACE_WIDTH : LETTER_WIDTH + LETTER_GAP), -LETTER_GAP)
  const grid: string[][] = Array.from({ length: 6 }, () => Array.from({ length: totalWidth }, () => ' '))
  let column = 0
  for (const glyph of glyphs) {
    if (glyph === null) {
      column += SPACE_WIDTH + LETTER_GAP
      continue
    }
    for (let row = 0; row < 5; row += 1) {
      for (let cell = 0; cell < LETTER_WIDTH; cell += 1) {
        grid[row]![column + cell] = glyph[row]![cell] ?? ' '
      }
    }
    column += LETTER_WIDTH + LETTER_GAP
  }
  const rows: BannerRow[] = []
  for (let row = 0; row < 6; row += 1) {
    const runs: BannerRun[] = []
    let current = ''
    let currentColor = ''
    for (let cell = 0; cell < totalWidth; cell += 1) {
      const main = grid[row]![cell] === '█'
      const shadow = row > 0 && cell > 0 && grid[row - 1]![cell - 1] === '█' && grid[row]![cell] !== '█'
      const color = main ? TITLE_MAIN_COLOR : shadow ? TITLE_SHADOW_COLOR : ''
      const character = main || shadow ? '█' : ' '
      if (color === currentColor) {
        current += character
      } else {
        if (current !== '') runs.push({ text: current, color: currentColor })
        current = character
        currentColor = color
      }
    }
    if (current !== '') runs.push({ text: current, color: currentColor })
    rows.push({ runs, width: totalWidth })
  }
  return rows
}

/** The precomputed 3D `DEEPSEEK HARNESS` title rows. */
export const TITLE_ROWS: readonly BannerRow[] = buildTitleRows('DEEPSEEK HARNESS')

/** The widest whale art line, in cells. */
export const WHALE_WIDTH: number = WHALE_ART.reduce((width, line) => Math.max(width, stringWidth(line)), 0)

/** The title width, in cells. */
export const TITLE_WIDTH: number = TITLE_ROWS[0]?.width ?? 0

/** The full banner's height (whale + gap + title). */
export const BANNER_HEIGHT: number = WHALE_ART.length + 1 + TITLE_ROWS.length

/**
 * Center one banner row in the content width, folding the left pad into the
 * first run so color segments stay intact.
 * @param runs - the row's colored segments.
 * @param rowWidth - the row's cell width.
 * @param contentWidth - the available cells.
 * @returns the centered runs.
 */
function centerRow(runs: readonly BannerRun[], rowWidth: number, contentWidth: number): BannerRun[] {
  const pad = Math.max(0, Math.floor((contentWidth - rowWidth) / 2))
  const first = runs[0]
  if (first === undefined) return [{ text: ' '.repeat(pad), color: '' }]
  return [{ text: `${' '.repeat(pad)}${first.text}`, color: first.color }, ...runs.slice(1)]
}

/** One rendered banner line entering the transcript. */
export interface WelcomeBannerLine {
  text: string
  color?: string
  runs?: BannerRun[]
}

/**
 * Compose the welcome banner for one viewport: whale + 3D title, both
 * centered. Degrades instead of wrapping — a too-narrow or too-short
 * viewport drops the title first, then the whale, and finally returns an
 * empty list so the renderer can fall back to the plain welcome card.
 * @param contentWidth - available cells.
 * @param height - available rows.
 * @returns the banner lines (empty when nothing fits).
 */
export function welcomeBanner(contentWidth: number, height: number): WelcomeBannerLine[] {
  const lines: WelcomeBannerLine[] = []
  if (contentWidth >= WHALE_WIDTH + 4 && height >= BANNER_HEIGHT + 1) {
    for (const art of WHALE_ART) {
      const pad = Math.max(0, Math.floor((contentWidth - stringWidth(art)) / 2))
      lines.push({ text: `${' '.repeat(pad)}${art}`, color: WHALE_COLOR })
    }
    lines.push({ text: '' })
    for (const row of TITLE_ROWS) {
      lines.push({ text: '', runs: centerRow(row.runs, row.width, contentWidth) })
    }
    return lines
  }
  if (contentWidth >= WHALE_WIDTH + 4 && height >= WHALE_ART.length + 1) {
    for (const art of WHALE_ART) {
      const pad = Math.max(0, Math.floor((contentWidth - stringWidth(art)) / 2))
      lines.push({ text: `${' '.repeat(pad)}${art}`, color: WHALE_COLOR })
    }
    return lines
  }
  return []
}
