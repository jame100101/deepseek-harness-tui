/**
 * Surgical text edits for toggling one plugin entry in the profile's user
 * patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`). The edits are
 * line-based so user comments and `!!js` expressions survive untouched —
 * a full YAML round-trip would strip them. The launcher's HMR watch hot-
 * applies the file after each write.
 * @module @deepseek-ai/dsh-tui/src/patch-toggle
 */

/**
 * Return the file content with `- id: <id>` carrying `disabled: true`.
 * An existing entry flips or gains its disable line; a missing entry is
 * appended (replacing a trailing flow-style `[]` when present).
 * @param content - the current patch file text.
 * @param id - the loader entry id to disable.
 * @returns the edited text.
 */
export function disableEntryText(content: string, id: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let found = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === `- id: ${id}`) {
      found = true
      out.push(line)
      const next = lines[index + 1] ?? ''
      if (/^[ \t]*disabled:/.test(next)) {
        out.push('  disabled: true')
        index += 1
      } else {
        out.push('  disabled: true')
      }
      continue
    }
    out.push(line)
  }
  if (found) return out.join('\n')
  const bracket = out.findIndex(line => line.trim() === '[]')
  const entry = [`- id: ${id}`, '  disabled: true']
  if (bracket !== -1) out.splice(bracket, 1, ...entry)
  else {
    // Insert before the trailing newline marker so the file keeps it.
    let insertAt = out.length
    while (insertAt > 0 && out[insertAt - 1]?.trim() === '') insertAt -= 1
    out.splice(insertAt, 0, ...entry)
  }
  return out.join('\n')
}

/**
 * Return the file content with the `- id: <id>` entry's `disabled: true`
 * line dropped; an entry left with only its id line is removed whole (a bare
 * `- id:` line would be a valid but noisy no-op patch).
 * @param content - the current patch file text.
 * @param id - the loader entry id to enable.
 * @returns the edited text.
 */
export function enableEntryText(content: string, id: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let inTarget = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^[ \t]*- /.test(line)) inTarget = line.trim() === `- id: ${id}`
    if (inTarget && /^[ \t]*disabled: true[ \t]*$/.test(line)) continue
    out.push(line)
  }
  const result = out
    .filter((line, index) => {
      if (line.trim() !== `- id: ${id}`) return true
      const next = out[index + 1] ?? ''
      return /^[ \t]+/.test(next) && !/^[ \t]*- /.test(next)
    })
    .join('\n')
  // A patch list must stay a YAML ARRAY: comments alone parse to null and
  // the launcher's reload rejects the file. Restore the flow-style empty
  // array when no entry remains.
  if (!/^[ \t]*\[/m.test(result) && !/^[ \t]*- /m.test(result)) {
    return `${result}${result.endsWith('\n') ? '' : '\n'}[]\n`
  }
  return result
}
