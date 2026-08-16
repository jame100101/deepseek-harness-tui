import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { externalDependencies, runtimeClosure, semverMax } from '../scripts/assemble-runtime.mjs'

const root = join(import.meta.dirname, '..', '..', '..')

describe('semverMax', () => {
  it('picks the numerically larger version, not the lexical one', () => {
    expect(semverMax('8.3.0', '15.0.0')).toBe('15.0.0')
    expect(semverMax('19.2.8', '18.3.1')).toBe('19.2.8')
    expect(semverMax('7.2.0', '7.2.0')).toBe('7.2.0')
  })
})

describe('runtimeClosure', () => {
  it('contains the launcher and the tui surface the profile mounts', () => {
    const closure = runtimeClosure(root)
    expect(closure.has('@deepseek-ai/dsh-base')).toBe(true)
    expect(closure.has('@deepseek-ai/dsh-tui-app')).toBe(true)
    expect(closure.has('@deepseek-ai/dsh-tui')).toBe(true)
    expect(closure.has('@deepseek-ai/cordis')).toBe(true)
    expect(closure.size).toBeGreaterThan(150)
  })
})

describe('externalDependencies', () => {
  it('pins every external to a real semver with no workspace protocol', () => {
    const deps = externalDependencies(root, runtimeClosure(root))
    expect(deps.size).toBeGreaterThan(40)
    for (const [name, version] of deps) {
      expect(version).toMatch(/^\d+\.\d+\.\d+/)
      expect(version).not.toContain('workspace:')
      expect(version).not.toContain('link:')
      expect(version).not.toContain('file:')
      expect(name.startsWith('@deepseek-ai/')).toBe(false)
    }
  })

  it('pins the launcher-facing commander to the v15 line', () => {
    const deps = externalDependencies(root, runtimeClosure(root))
    expect(deps.get('commander')).toBe('15.0.0')
  })
})

describe('assembled runtime (when present)', () => {
  it('ships the launcher bin, the agent-preset config, and the bundle patches', () => {
    const runtime = join(root, 'apps/tui-cli/runtime')
    if (!existsSync(runtime)) return // built at release time; skip when absent
    expect(existsSync(join(runtime, 'lib/bin.js'))).toBe(true)
    expect(existsSync(join(runtime, 'config/agent-presets'))).toBe(true)
    expect(existsSync(join(runtime, 'node_modules/@deepseek-ai/dsh-tui-app/cordis.patch.yml'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')) as { bin?: { dsh?: string } }
    expect(manifest.bin?.dsh).toBe('lib/bin.js')
  })
})
