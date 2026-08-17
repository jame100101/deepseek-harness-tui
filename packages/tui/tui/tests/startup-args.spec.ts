import { describe, expect, it } from 'vitest'
import { parseTuiStartupIntent } from '../src/startup-args'

describe('parseTuiStartupIntent', () => {
  it('defaults to an interactive new session with no args', () => {
    expect(parseTuiStartupIntent([])).toEqual({ mode: 'interactive', base: { kind: 'new' }, fork: false })
  })

  it('takes a positional task as the interactive prompt', () => {
    expect(parseTuiStartupIntent(['fix this bug']))
      .toEqual({ mode: 'interactive', base: { kind: 'new' }, fork: false, prompt: 'fix this bug' })
  })

  it('parses -c and --continue', () => {
    expect(parseTuiStartupIntent(['-c']).base).toEqual({ kind: 'continue' })
    expect(parseTuiStartupIntent(['--continue']).base).toEqual({ kind: 'continue' })
  })

  it('parses a bare -r and --resume as the picker', () => {
    expect(parseTuiStartupIntent(['-r']).base).toEqual({ kind: 'resume-picker' })
    expect(parseTuiStartupIntent(['--resume']).base).toEqual({ kind: 'resume-picker' })
  })

  it('parses -r <query> and --resume <query>', () => {
    expect(parseTuiStartupIntent(['-r', 'session-1']).base).toEqual({ kind: 'resume', query: 'session-1' })
    expect(parseTuiStartupIntent(['--resume', 'session-1']).base).toEqual({ kind: 'resume', query: 'session-1' })
  })

  it('rejects --fork-session without a base', () => {
    expect(() => parseTuiStartupIntent(['--fork-session'])).toThrowError(expect.objectContaining({ exitCode: 2 }))
    expect(() => parseTuiStartupIntent(['-r', '--fork-session'])).toThrowError(expect.objectContaining({ exitCode: 2 }))
  })

  it('accepts -c --fork-session and -r <query> --fork-session', () => {
    expect(parseTuiStartupIntent(['-c', '--fork-session']))
      .toEqual({ mode: 'interactive', base: { kind: 'continue' }, fork: true })
    expect(parseTuiStartupIntent(['-r', 'session-1', '--fork-session']))
      .toEqual({ mode: 'interactive', base: { kind: 'resume', query: 'session-1' }, fork: true })
  })

  it('parses -p task into print mode', () => {
    expect(parseTuiStartupIntent(['-p', 'run the tests']))
      .toEqual({ mode: 'print', base: { kind: 'new' }, fork: false, prompt: 'run the tests' })
  })

  it('parses -c -p task and -r <query> -p task', () => {
    expect(parseTuiStartupIntent(['-c', '-p', 'run the tests']))
      .toEqual({ mode: 'print', base: { kind: 'continue' }, fork: false, prompt: 'run the tests' })
    expect(parseTuiStartupIntent(['-r', 'session-1', '-p', 'run the tests']))
      .toEqual({ mode: 'print', base: { kind: 'resume', query: 'session-1' }, fork: false, prompt: 'run the tests' })
  })

  it('rejects -c with -r', () => {
    expect(() => parseTuiStartupIntent(['-c', '-r', 'session-1'])).toThrowError(expect.objectContaining({ exitCode: 2 }))
    expect(() => parseTuiStartupIntent(['-c', '-r'])).toThrowError(expect.objectContaining({ exitCode: 2 }))
  })

  it('rejects -p without a task', () => {
    expect(() => parseTuiStartupIntent(['-p'])).toThrowError(expect.objectContaining({ code: 'commander.optionMissingArgument' }))
  })

  it('rejects -p task with a positional task', () => {
    expect(() => parseTuiStartupIntent(['-p', 'a', 'b'])).toThrowError(expect.objectContaining({ exitCode: 2 }))
  })

  it('rejects a positional task with --prompt', () => {
    expect(() => parseTuiStartupIntent(['--prompt', 'a', 'b'])).toThrowError(expect.objectContaining({ exitCode: 2 }))
  })

  it('rejects -p task with a bare -r picker', () => {
    expect(() => parseTuiStartupIntent(['-r', '-p', 'task'])).toThrowError(expect.objectContaining({ exitCode: 2 }))
  })

  it('rejects an unknown flag', () => {
    expect(() => parseTuiStartupIntent(['--bogus'])).toThrowError(expect.objectContaining({ code: 'commander.unknownOption' }))
  })

  it('treats -- as the end of flags', () => {
    expect(parseTuiStartupIntent(['--', '-fix this']))
      .toEqual({ mode: 'interactive', base: { kind: 'new' }, fork: false, prompt: '-fix this' })
  })

  it('throws commander control-flow on --help and --version', () => {
    expect(() => parseTuiStartupIntent(['--help'])).toThrowError(expect.objectContaining({ code: 'commander.helpDisplayed' }))
    expect(() => parseTuiStartupIntent(['--version'])).toThrowError(expect.objectContaining({ code: 'commander.version' }))
  })
})
