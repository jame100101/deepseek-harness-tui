import { describe, expect, it } from 'vitest'
import { projectResultCard } from '../src/card-project'

describe('projectResultCard locale', () => {
  it('renders search, read, and web chrome entirely in English', () => {
    const search = projectResultCard({
      card: 'search',
      shape: 'paths',
      paths: ['src/index.ts'],
      total: 5,
      truncated: true,
    } as never, '', 'en')
    const read = projectResultCard({
      card: 'read',
      path: 'src/index.ts',
      offset: 1,
      totalLines: 20,
      lines: [{ number: 1, text: 'export {}' }],
    } as never, '', 'en')
    const web = projectResultCard({
      card: 'web',
      kind: 'fetch',
      url: 'https://example.test',
      statusCode: 200,
      truncated: true,
    } as never, '', 'en')
    const text = [...search, ...read, ...web].map(line => line.text).join('\n')
    expect(text).toContain('truncated (showing 1/5)')
    expect(text).toContain('of 20 lines')
    expect(text).toContain('content truncated')
    expect(text).not.toMatch(/\p{Script=Han}/u)
  })

  it('retains Chinese card labels in the Chinese locale', () => {
    const rows = projectResultCard({
      card: 'search',
      shape: 'paths',
      paths: [],
      total: 3,
      truncated: false,
    } as never, '', 'zh')
    expect(rows.at(-1)?.text).toBe('共 3 项')
  })
})
