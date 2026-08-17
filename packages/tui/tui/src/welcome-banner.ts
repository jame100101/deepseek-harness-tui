/**
 * The first-load welcome banner: the DeepSeek whale pixel art (an immutable
 * literal, never generated at runtime) over a block-style 3D `DEEPSEEK
 * HARNESS` title with a bottom-right shadow. Both center horizontally; the
 * whole block degrades instead of wrapping when the terminal is too narrow
 * or short, so the art can never break apart.
 * @module @deepseek-ai/dsh-tui/src/welcome-banner
 */

import stringWidth from 'string-width'

/**
 * The DeepSeek whale art as one raw multi-line string — verbatim: never
 * trimmed, dedented, formatted, wrapped, or re-flowed. Leading indentation
 * is plain ASCII spaces (U+0020, no tabs). Every glyph is a single-cell
 * block shade (`█` `▓` `▒` `░`) or an ASCII space, so Cascadia Mono,
 * JetBrains Mono, and Consolas all render exactly one terminal cell per
 * character with no font fallback and no width drift.
 */
export const WHALE_ART_RAW: string = `                ░░▒▓▓▓░     ▒█░
      ░▒▓▓████████████░      ███▓▒       ▒▓
  ▓█████████████████████▒   ░████████████░
 █████████████████████████▒  ░▓████████▓░
▓██▓▓▓▓█████████████████████▒░ ▓███▓▒░
███      ░▒▓██████████▒▒▓██████████▒
███          ░▓███████▒█  ▓████████
███▓           ░▓███████░  ░██████▒
▒███░            ░███████▓▓██████▓
 ░████▒      ░▒░    ▒██████████▒
  ░▓████▒░   ░███▒░  ░███████▓░
      ░▓███████████████▓▓▓▒▒▓▓▓▓▒░
         ░▒▓▓███████▓▓▒░`

/** The raw whale art split into lines; `split` never trims or re-flows. */
export const WHALE_ART: readonly string[] = WHALE_ART_RAW.split('\n')

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

/**
 * 6-column x 5-row block glyphs for the title's letters, drawn in `█` only.
 * ANSI-Shadow-inspired letterforms; the 3D depth comes from the computed
 * `░` shadow layer, never from box-drawing or fullwidth characters.
 */
const FONT: Record<string, readonly string[]> = {
  D: ['█████ ', '██  ██', '██  ██', '██  ██', '█████ '],
  E: ['██████', '██    ', '█████ ', '██    ', '██████'],
  P: ['█████ ', '██  ██', '█████ ', '██    ', '██    '],
  S: ['██████', '██    ', '█████ ', '    ██', '██████'],
  K: ['██  ██', '██ ██ ', '████  ', '██ ██ ', '██  ██'],
  H: ['██  ██', '██  ██', '██████', '██  ██', '██  ██'],
  A: [' ████ ', '██  ██', '██████', '██  ██', '██  ██'],
  R: ['█████ ', '██  ██', '█████ ', '██ ██ ', '██  ██'],
  N: ['██  ██', '███ ██', '██ ███', '██  ██', '██  ██'],
}

const LETTER_WIDTH = 6
const LETTER_GAP = 1
const SPACE_WIDTH = 3
const GLYPH_ROWS = 5

/**
 * Precompute the 3D title: `GLYPH_ROWS` rows of block text plus one trailing
 * shadow row, offset one row down and one column right. A shadow cell is
 * drawn as a `░` where the main glyph does not already paint. Deterministic
 * module-scope build — no external commands, no runtime generation.
 * @param text - the title text.
 * @returns the precomputed rows.
 */
function buildTitleRows(text: string): BannerRow[] {
  const glyphs = [...text].map(character => FONT[character] ?? null)
  const totalWidth = glyphs.reduce((width, glyph) => width + (glyph === null ? SPACE_WIDTH : LETTER_WIDTH + LETTER_GAP), -LETTER_GAP)
  const grid: string[][] = Array.from({ length: GLYPH_ROWS + 1 }, () => Array.from({ length: totalWidth }, () => ' '))
  let column = 0
  for (const glyph of glyphs) {
    if (glyph === null) {
      column += SPACE_WIDTH + LETTER_GAP
      continue
    }
    for (let row = 0; row < GLYPH_ROWS; row += 1) {
      const gridRow = grid[row]
      const glyphRow = glyph[row]
      if (gridRow === undefined || glyphRow === undefined) continue
      for (let cell = 0; cell < LETTER_WIDTH; cell += 1) {
        gridRow[column + cell] = glyphRow[cell] ?? ' '
      }
    }
    column += LETTER_WIDTH + LETTER_GAP
  }
  const rows: BannerRow[] = []
  for (let row = 0; row < GLYPH_ROWS + 1; row += 1) {
    const runs: BannerRun[] = []
    let current = ''
    let currentColor = ''
    for (let cell = 0; cell < totalWidth; cell += 1) {
      const gridRow = grid[row] ?? []
      const main = gridRow[cell] === '█'
      const shadow = row > 0 && cell > 0 && (grid[row - 1]?.[cell - 1] ?? '') === '█' && gridRow[cell] !== '█'
      const color = main ? TITLE_MAIN_COLOR : shadow ? TITLE_SHADOW_COLOR : ''
      const character = main ? '█' : shadow ? '░' : ' '
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

/** The full banner's height (whale + title). */
export const BANNER_HEIGHT: number = WHALE_ART.length + TITLE_ROWS.length

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
