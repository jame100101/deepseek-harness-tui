import { describe, expect, it } from 'vitest'
import { disableEntryText, enableEntryText } from '../src/patch-toggle'

const TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries.
[]
`

describe('disableEntryText', () => {
  it('replaces a trailing flow-style [] with the new entry and keeps comments', () => {
    const next = disableEntryText(TEMPLATE, 'storage')
    expect(next).toContain('- id: storage\n  disabled: true\n')
    expect(next).toContain('# Your patch layer')
    expect(next).not.toContain('[]')
  })

  it('inserts the disable line into an existing entry', () => {
    const next = disableEntryText('- id: storage\n  config: {a: 1}\n', 'storage')
    expect(next).toBe('- id: storage\n  disabled: true\n  config: {a: 1}\n')
  })

  it('flips an existing disabled: false to true', () => {
    const next = disableEntryText('- id: storage\n  disabled: false\n', 'storage')
    expect(next).toBe('- id: storage\n  disabled: true\n')
  })

  it('appends a fresh entry when no [] bracket exists', () => {
    const next = disableEntryText('# comment\n- id: other\n  disabled: true\n', 'storage')
    expect(next).toBe('# comment\n- id: other\n  disabled: true\n- id: storage\n  disabled: true\n')
  })
})

describe('enableEntryText', () => {
  it('removes a whole entry whose only field is the disable line', () => {
    const next = enableEntryText('# c\n- id: storage\n  disabled: true\n- id: other\n', 'storage')
    expect(next).toBe('# c\n- id: other\n')
  })

  it('restores the flow-style [] when the last entry is removed (file stays a YAML array)', () => {
    const next = enableEntryText('# comments\n- id: timer\n  disabled: true\n', 'timer')
    expect(next).toBe('# comments\n[]\n')
  })

  it('drops only the disable line when the entry keeps other fields', () => {
    const next = enableEntryText('- id: storage\n  disabled: true\n  config: {a: 1}\n', 'storage')
    expect(next).toBe('- id: storage\n  config: {a: 1}\n')
  })

  it('leaves unrelated entries untouched', () => {
    const source = '- id: other\n  disabled: true\n'
    expect(enableEntryText(source, 'storage')).toBe(source)
  })
})
