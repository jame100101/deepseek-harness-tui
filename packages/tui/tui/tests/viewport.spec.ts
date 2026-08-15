import { describe, expect, it } from 'vitest'
import {
  nextCodePointBoundary, previousCodePointBoundary, selectComposerLayout, selectInputViewport, selectPanelViewport, selectTranscriptViewport,
} from '../src/viewport'
import type { TranscriptLine } from '../src/viewport'

const line = (key: string, text = key): TranscriptLine => ({ key, text })

describe('selectTranscriptViewport', () => {
  it('follows the newest lines at offset 0', () => {
    const lines = Array.from({ length: 10 }, (_, index) => line(`l${index}`))
    const viewport = selectTranscriptViewport(lines, 5, 0)
    expect(viewport.offset).toBe(0)
    expect(viewport.maximumOffset).toBe(5) // 10 lines - 5 content rows
    expect(viewport.lines.map(entry => entry.text)).toEqual(['l5', 'l6', 'l7', 'l8', 'l9'])
  })

  it('hides lines from the bottom as the offset grows', () => {
    const lines = Array.from({ length: 10 }, (_, index) => line(`l${index}`))
    const viewport = selectTranscriptViewport(lines, 5, 3)
    expect(viewport.offset).toBe(3)
    // The last 3 lines hidden; the window shows the 5 before them.
    expect(viewport.lines.map(entry => entry.text)).toEqual(['l2', 'l3', 'l4', 'l5', 'l6'])
  })

  it('clamps the offset to the maximum and never hides the first line', () => {
    const lines = Array.from({ length: 3 }, (_, index) => line(`l${index}`))
    const viewport = selectTranscriptViewport(lines, 5, 99)
    expect(viewport.maximumOffset).toBe(0)
    expect(viewport.offset).toBe(0)
    expect(viewport.lines.length).toBe(3)
  })

  it('returns an empty slice for an empty transcript', () => {
    const viewport = selectTranscriptViewport([], 5, 0)
    expect(viewport.lines).toEqual([])
    expect(viewport.maximumOffset).toBe(0)
  })

  it('reserves bottom rows for a pinned button without losing the tail', () => {
    const lines = Array.from({ length: 10 }, (_, index) => line(`l${index}`))
    const viewport = selectTranscriptViewport(lines, 5, 0, 1)
    expect(viewport.lines.map(entry => entry.text)).toEqual(['l6', 'l7', 'l8', 'l9'])
    expect(viewport.maximumOffset).toBe(6)
  })

  it('shrinks the content window further while scrolled with a bottom row reserved', () => {
    const lines = Array.from({ length: 10 }, (_, index) => line(`l${index}`))
    const viewport = selectTranscriptViewport(lines, 5, 2, 1)
    expect(viewport.lines.map(entry => entry.text)).toEqual(['l4', 'l5', 'l6', 'l7'])
  })
})

describe('selectPanelViewport', () => {
  const rows = (count: number): TranscriptLine[] => Array.from({ length: count }, (_, index) => line(`r${index}`))

  it('anchors offset 0 to the TOP of the list (no tail following)', () => {
    const viewport = selectPanelViewport(rows(30), 5, 0)
    expect(viewport.lines.map(entry => entry.text)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
    expect(viewport.maximumOffset).toBe(25)
  })

  it('counts hidden rows from the top and reserves no banner row', () => {
    const viewport = selectPanelViewport(rows(30), 5, 8)
    expect(viewport.lines.map(entry => entry.text)).toEqual(['r8', 'r9', 'r10', 'r11', 'r12'])
    expect(viewport.offset).toBe(8)
  })

  it('clamps the offset so the last rows stay reachable', () => {
    const viewport = selectPanelViewport(rows(30), 5, 99)
    expect(viewport.offset).toBe(25)
    expect(viewport.lines.map(entry => entry.text)).toEqual(['r25', 'r26', 'r27', 'r28', 'r29'])
  })

  it('returns an empty slice for an empty list', () => {
    const viewport = selectPanelViewport([], 5, 0)
    expect(viewport.lines).toEqual([])
    expect(viewport.maximumOffset).toBe(0)
  })
})

describe('selectInputViewport', () => {
  it('shows the whole value with the caret column at its end', () => {
    const viewport = selectInputViewport('hello', 5, 12)
    expect(viewport.text).toBe('hello')
    expect(viewport.cursorColumn).toBe(5)
  })

  it('reserves one cell for the native cursor', () => {
    // Width 6 → 5 usable cells; 'hello' (5) fills them exactly.
    const viewport = selectInputViewport('hello', 5, 6)
    expect(viewport.text).toBe('hello')
    expect(viewport.cursorColumn).toBe(5)
  })

  it('ellipsizes the right side when the caret is near the start', () => {
    const viewport = selectInputViewport('abcdefghij', 0, 8)
    expect(viewport.text).toBe('abcdef…')
    expect(viewport.cursorColumn).toBe(0)
  })

  it('ellipsizes both sides with the caret in the middle', () => {
    const viewport = selectInputViewport('abcdefghijklmnop', 8, 10)
    expect(viewport.text.startsWith('…')).toBe(true)
    expect(viewport.text.endsWith('…')).toBe(true)
    expect(viewport.cursorColumn).toBeGreaterThan(0)
  })
})

describe('code-point boundaries', () => {
  it('steps over surrogate pairs', () => {
    const emoji = 'a😀b'
    expect(previousCodePointBoundary(emoji, 3)).toBe(1)
    expect(nextCodePointBoundary(emoji, 1)).toBe(3)
  })
})

describe('selectComposerLayout', () => {
  it('keeps a short value on one line with the caret at its end', () => {
    const layout = selectComposerLayout('hello', 5, 20, 5)
    expect(layout.visibleLines).toEqual(['hello'])
    expect(layout.caretLine).toBe(0)
    expect(layout.caretColumn).toBe(5)
  })

  it('wraps overflowing text onto a second line instead of truncating', () => {
    const layout = selectComposerLayout('abcdefghij', 10, 4, 5)
    expect(layout.visibleLines).toEqual(['abcd', 'efgh', 'ij'])
    expect(layout.caretLine).toBe(2)
    expect(layout.caretColumn).toBe(2)
  })

  it('places the caret at column 0 on the next line when the prefix fills a row exactly', () => {
    const layout = selectComposerLayout('abcdefgh', 4, 4, 5)
    expect(layout.visibleLines).toEqual(['abcd', 'efgh'])
    expect(layout.caretLine).toBe(1)
    expect(layout.caretColumn).toBe(0)
  })

  it('keeps the caret on its own line with the caret column inside the prefix', () => {
    const layout = selectComposerLayout('abcdefghij', 7, 4, 5)
    expect(layout.visibleLines).toEqual(['abcd', 'efgh', 'ij'])
    expect(layout.caretLine).toBe(1)
    expect(layout.caretColumn).toBe(3)
  })

  it('caps the visible window at maxLines with the caret line last', () => {
    const value = 'a'.repeat(40)
    const layout = selectComposerLayout(value, 40, 4, 3)
    expect(layout.visibleLines).toEqual(['aaaa', 'aaaa', 'aaaa'])
    expect(layout.caretLine).toBe(2)
    expect(layout.caretColumn).toBe(4)
  })

  it('slides the window so an early caret stays visible at the window head', () => {
    const value = 'a'.repeat(40)
    const layout = selectComposerLayout(value, 2, 4, 3)
    expect(layout.visibleLines).toEqual(['aaaa', 'aaaa', 'aaaa'])
    expect(layout.caretLine).toBe(0)
    expect(layout.caretColumn).toBe(2)
  })

  it('keeps a mid-text caret inside a sliding window', () => {
    const value = 'a'.repeat(40)
    const layout = selectComposerLayout(value, 20, 4, 3)
    expect(layout.visibleLines).toEqual(['aaaa', 'aaaa', 'aaaa'])
    expect(layout.caretLine).toBe(2)
    expect(layout.caretColumn).toBe(0)
  })

  it('honors explicit newlines from Shift+Enter', () => {
    const layout = selectComposerLayout('ab\ncd', 5, 20, 5)
    expect(layout.visibleLines).toEqual(['ab', 'cd'])
    expect(layout.caretLine).toBe(1)
    expect(layout.caretColumn).toBe(2)
  })

  it('wraps a CJK run by display cells', () => {
    const layout = selectComposerLayout('中文测试文本', 6, 4, 5)
    expect(layout.visibleLines).toEqual(['中文', '测试', '文本'])
    expect(layout.caretLine).toBe(2)
    expect(layout.caretColumn).toBe(4)
  })

  it('returns one empty line for an empty value', () => {
    const layout = selectComposerLayout('', 0, 20, 5)
    expect(layout.visibleLines).toEqual([''])
    expect(layout.caretLine).toBe(0)
    expect(layout.caretColumn).toBe(0)
  })
})
