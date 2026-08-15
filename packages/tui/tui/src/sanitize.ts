/**
 * Strip terminal control sequences from untrusted text surfaces (model
 * output, tool results, pasted input). Ported from the DamnatioX TypeScript
 * TUI's `terminalText.ts`.
 * @module @deepseek-ai/dsh-tui/src/sanitize
 */

/**
 * Remove escape/control sequences (CSI, OSC, DCS, and bare escapes) plus C0
 * control characters from one string.
 * @param value - the untrusted text.
 * @returns the sanitized text.
 */
export function sanitizeTerminalText(value: string): string {
  let result = ''
  let index = 0
  while (index < value.length) {
    const code = value.charCodeAt(index)
    if (code === 0x1b) {
      index = skipEscapeSequence(value, index + 1)
      continue
    }
    if (code === 0x9b) {
      index = skipControlSequence(value, index + 1)
      continue
    }
    if (code === 0x9d) {
      index = skipStringSequence(value, index + 1, true)
      continue
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = skipStringSequence(value, index + 1, false)
      continue
    }
    if (
      (code >= 0 && code <= 0x08) ||
      (code >= 0x0b && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      index += 1
      continue
    }
    result += value[index] ?? ''
    index += 1
  }
  return result
}

function skipEscapeSequence(value: string, index: number): number {
  const introducer = value.charCodeAt(index)
  if (introducer === 0x5b) return skipControlSequence(value, index + 1)
  if (introducer === 0x5d) return skipStringSequence(value, index + 1, true)
  if (introducer === 0x50 || introducer === 0x58 || introducer === 0x5e || introducer === 0x5f) {
    return skipStringSequence(value, index + 1, false)
  }
  while (index < value.length) {
    const code = value.charCodeAt(index)
    index += 1
    if (code >= 0x30 && code <= 0x7e) break
  }
  return index
}

function skipControlSequence(value: string, index: number): number {
  while (index < value.length) {
    const code = value.charCodeAt(index)
    index += 1
    if (code >= 0x40 && code <= 0x7e) break
  }
  return index
}

function skipStringSequence(value: string, index: number, bellTerminates: boolean): number {
  while (index < value.length) {
    const code = value.charCodeAt(index)
    if (bellTerminates && code === 0x07) return index + 1
    if (code === 0x9c) return index + 1
    if (code === 0x1b && index + 1 < value.length && value.charCodeAt(index + 1) === 0x5c) {
      return index + 2
    }
    index += 1
  }
  return index
}
