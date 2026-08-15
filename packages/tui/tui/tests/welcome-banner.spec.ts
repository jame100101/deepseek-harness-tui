import { describe, expect, it } from 'vitest'
import stringWidth from 'string-width'
import {
  BANNER_HEIGHT, TITLE_MAIN_COLOR, TITLE_ROWS, TITLE_SHADOW_COLOR, WHALE_ART, WHALE_ART_RAW, WHALE_COLOR, WHALE_WIDTH,
  welcomeBanner,
} from '../src/welcome-banner'

describe('whale art literal', () => {
  it('keeps the verbatim 13-line whale art', () => {
    expect(WHALE_ART).toHaveLength(13)
    expect(WHALE_ART[0]).toBe('                ░░▒▓▓▓░     ▒█░')
    expect(WHALE_ART[12]).toBe('         ░▒▓▓███████▓▓▒░')
    // Distinctive features: the textured back, the mouth gap, the fin notch,
    // and the bottom-left belly arc.
    expect(WHALE_ART[4]).toContain('▓██▓▓▓▓████')
    expect(WHALE_ART[6]).toContain('          ░▓███████▒█')
    expect(WHALE_ART[9]).toContain('░▒░')
    expect(WHALE_ART[11]).toContain('▓▓▓▒▒▓▓▓▓▒░')
  })

  it('stores the art as one raw multi-line string without tabs, trailing spaces, or wrapping', () => {
    expect(WHALE_ART_RAW.split('\n')).toHaveLength(13)
    for (const line of WHALE_ART_RAW.split('\n')) {
      expect(line).not.toContain('\t')
      expect(line).toBe(line.trimEnd())
    }
  })

  it('uses only guaranteed single-cell characters (space + █ ▓ ▒ ░), never fallback-prone glyphs', () => {
    for (const line of WHALE_ART) {
      for (const character of line) {
        expect(' █▓▒░'.includes(character)).toBe(true)
      }
    }
  })

  it('measures the art width in terminal cells without breaking the literal', () => {
    expect(WHALE_WIDTH).toBe(43)
    for (const line of WHALE_ART) {
      expect(stringWidth(line)).toBeLessThanOrEqual(WHALE_WIDTH)
    }
  })
})

describe('3D title', () => {
  it('precomputes six equal-width rows of pure █ glyphs with a ░ shadow row', () => {
    expect(TITLE_ROWS).toHaveLength(6)
    const widths = new Set(TITLE_ROWS.map(row => row.width))
    expect(widths.size).toBe(1)
    expect(TITLE_ROWS[0]?.width).toBe(107)
    // Strict column alignment: every row's runs reconstruct exactly the
    // row width, and every character is a single-cell block or a space.
    for (const row of TITLE_ROWS) {
      let cells = 0
      for (const run of row.runs) {
        for (const character of run.text) {
          expect(' █░'.includes(character)).toBe(true)
        }
        cells += stringWidth(run.text)
      }
      expect(cells).toBe(row.width)
    }
    const main = TITLE_ROWS[0]?.runs.find(run => run.color === TITLE_MAIN_COLOR)
    expect(main?.text.includes('█')).toBe(true)
    // The trailing shadow row carries only ░ cells in the shadow color.
    const shadowRow = TITLE_ROWS[5]
    expect(shadowRow?.runs.some(run => run.color === TITLE_SHADOW_COLOR && run.text.includes('░'))).toBe(true)
    expect(shadowRow?.runs.some(run => run.color === TITLE_MAIN_COLOR)).toBe(false)
    expect(shadowRow?.runs.every(run => !run.text.includes('█'))).toBe(true)
  })
})

describe('welcomeBanner layout', () => {
  it('renders whale + title when the viewport fits both, without a wrap', () => {
    const banner = welcomeBanner(98, 20)
    expect(banner).toHaveLength(BANNER_HEIGHT)
    expect(banner[0]?.color).toBe(WHALE_COLOR)
    expect(banner[0]?.text.trim()).toBe(WHALE_ART[0]?.trim())
    const titleRow = banner[WHALE_ART.length]
    expect(titleRow?.runs?.length).toBeGreaterThan(0)
    // The whale centers: the pad equals half the remaining cells.
    const pad = (98 - stringWidth(WHALE_ART[0]!)) / 2
    expect(banner[0]?.text.startsWith(' '.repeat(Math.floor(pad)))).toBe(true)
    // The art is never trimmed or re-indented: the raw leading spaces
    // survive the centered render (pad + verbatim line).
    expect(banner[0]?.text).toBe(`${' '.repeat(Math.floor(pad))}${WHALE_ART[0]}`)
  })

  it('degrades to the whale only when the height is too short for the title', () => {
    const banner = welcomeBanner(98, 14)
    expect(banner).toHaveLength(WHALE_ART.length)
    expect(banner.some(line => line.runs !== undefined)).toBe(false)
  })

  it('degrades to nothing when the width cannot hold the art (never wraps)', () => {
    expect(welcomeBanner(20, 30)).toEqual([])
  })
})
