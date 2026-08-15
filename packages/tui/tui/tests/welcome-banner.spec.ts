import { describe, expect, it } from 'vitest'
import stringWidth from 'string-width'
import {
  BANNER_HEIGHT, TITLE_MAIN_COLOR, TITLE_ROWS, TITLE_SHADOW_COLOR, WHALE_ART, WHALE_COLOR, WHALE_WIDTH,
  welcomeBanner,
} from '../src/welcome-banner'

describe('whale art literal', () => {
  it('keeps the verbatim 12-line whale art', () => {
    expect(WHALE_ART).toHaveLength(12)
    expect(WHALE_ART[0]).toBe('              ⣀⣀⣀⡀       ⣤⡀')
    expect(WHALE_ART[11]).toBe('           ⠉⠉⠛⠛⠛⠛⠉')
    expect(WHALE_ART[4]).toContain('⣿⣿⠋⠉⠉⠛⠿⣿⣿')
  })

  it('measures the art width without breaking the literal', () => {
    expect(WHALE_WIDTH).toBe(35)
    for (const line of WHALE_ART) {
      expect(stringWidth(line)).toBeLessThanOrEqual(WHALE_WIDTH)
    }
  })
})

describe('3D title', () => {
  it('precomputes six rows of equal width with bright glyphs and a dark shadow', () => {
    expect(TITLE_ROWS).toHaveLength(6)
    const widths = new Set(TITLE_ROWS.map(row => row.width))
    expect(widths.size).toBe(1)
    const main = TITLE_ROWS[0]?.runs.find(run => run.color === TITLE_MAIN_COLOR)
    expect(main?.text.includes('█')).toBe(true)
    // The trailing shadow row carries only dark cells (no main glyphs).
    const shadowRow = TITLE_ROWS[5]
    expect(shadowRow?.runs.some(run => run.color === TITLE_SHADOW_COLOR)).toBe(true)
    expect(shadowRow?.runs.some(run => run.color === TITLE_MAIN_COLOR)).toBe(false)
  })
})

describe('welcomeBanner layout', () => {
  it('renders whale + title when the viewport fits both', () => {
    const banner = welcomeBanner(98, 20)
    expect(banner).toHaveLength(BANNER_HEIGHT)
    expect(banner[0]?.color).toBe(WHALE_COLOR)
    expect(banner[0]?.text.trim()).toBe(WHALE_ART[0]?.trim())
    const titleRow = banner[WHALE_ART.length + 1]
    expect(titleRow?.runs?.length).toBeGreaterThan(0)
    // The whale centers: the pad equals half the remaining cells.
    const pad = (98 - stringWidth(WHALE_ART[0]!)) / 2
    expect(banner[0]?.text.startsWith(' '.repeat(Math.floor(pad)))).toBe(true)
  })

  it('degrades to the whale only when the height is too short for the title', () => {
    const banner = welcomeBanner(98, 13)
    expect(banner).toHaveLength(WHALE_ART.length)
    expect(banner.some(line => line.runs !== undefined)).toBe(false)
  })

  it('degrades to nothing when the width cannot hold the art (never wraps)', () => {
    expect(welcomeBanner(20, 30)).toEqual([])
  })
})
