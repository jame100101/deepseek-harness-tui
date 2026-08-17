/**
 * Surgical text edits for toggling one plugin entry in the profile's user
 * patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`). The edits are
 * line-based so user comments and `!!js` expressions survive untouched —
 * a full YAML round-trip would strip them. The launcher's HMR watch hot-
 * applies the file after each write.
 * @module @deepseek-ai/dsh-tui/src/patch-toggle
 */

interface LoaderEntryView {
  id: string
  disabled: boolean
  options: { id: string; name: string; group?: boolean | null; disabled?: unknown }
  fiber?: {
    inject: Record<string, unknown>
    store?: Record<string, unknown> | undefined
  } | undefined
  subgroup?: unknown
  subtree?: unknown
}

const GENERATED_LOADER_ID = /^[0-9a-f]{8}$/

/**
 * Decide whether one Loader entry represents a leaf plugin suitable for the
 * settings inventory. Include carriers, nested groups, and internal ids stay
 * out of the switch list because disabling them cascades into unrelated rows.
 * @param entry - Loader entry facts needed by the inventory.
 * @returns whether the row is a leaf plugin switch.
 */
export function isPluginInventoryEntry(entry: LoaderEntryView): boolean {
  return entry.options.group !== true
    && entry.id !== entry.options.id
    && entry.subgroup === undefined
    && entry.subtree === undefined
    && !entry.options.id.includes(':')
    // EntryTree.ensureId() assigns this form to dynamically mounted rows that
    // omitted an id. They have no stable patch target across launches.
    && !GENERATED_LOADER_ID.test(entry.options.id)
}

/**
 * List enabled Loader entries that require a service owned by `target`.
 * Disabling such a provider would leave those rows pending and make the next
 * strict application boot fail, so it stays outside the independent switch
 * inventory and remains visible through the read-only Inventory page.
 * @param entries - the settled Loader tree.
 * @param target - the active provider considered for disabling.
 * @returns unique dependent entry ids, alphabetically sorted.
 */
export function pluginDisableBlockers(entries: readonly LoaderEntryView[], target: LoaderEntryView): string[] {
  const provided = new Set(Object.keys(target.fiber?.store ?? {}))
  if (provided.size === 0) return []
  return [...new Set(entries
    // Include/group fibers inherit injections for their subtree. Generated-id
    // leaf fibers are real dependents but are named by module because their id
    // is intentionally unstable across launches.
    .filter(entry => entry !== target
      && entry.subgroup === undefined
      && entry.subtree === undefined
      && !entry.disabled
      && entry.fiber !== undefined)
    .filter(entry => Object.keys(entry.fiber?.inject ?? {}).some(service => provided.has(service)))
    .map((entry) => {
      if (!GENERATED_LOADER_ID.test(entry.options.id)) return entry.options.id
      return GENERATED_LOADER_ID.test(entry.options.name) ? 'dynamic-plugin' : entry.options.name
    }))]
    .sort((left, right) => left.localeCompare(right))
}

/**
 * Detect a Loader entry whose enabled state is an evaluated expression rather
 * than a literal switch. Environment/platform-owned rows stay read-only in the
 * TUI so a user patch does not override their deployment condition.
 * @param entry - Loader entry to inspect.
 * @returns whether its disabled state is expression-owned.
 */
export function hasConditionalDisabledState(entry: LoaderEntryView): boolean {
  return entry.options.disabled !== undefined
    && entry.options.disabled !== null
    && typeof entry.options.disabled !== 'boolean'
}

/**
 * Return the file content with `- id: <id>` carrying `disabled: true`.
 * An existing entry flips or gains its disable line; a missing entry is
 * appended (replacing a trailing flow-style `[]` when present).
 * @param content - the current patch file text.
 * @param id - the loader entry id to disable.
 * @returns the edited text.
 */
export function disableEntryText(content: string, id: string): string {
  return setEntryDisabledText(content, id, true)
}

/**
 * Return the file content with `- id: <id>` carrying `disabled: false`.
 * The explicit override is required for entries disabled by an earlier bundle
 * layer; removing a user-layer `disabled: true` row would merely reveal that
 * earlier disabled state and make the switch appear to succeed without
 * activating the plugin.
 * @param content - the current patch file text.
 * @param id - the loader entry id to enable.
 * @returns the edited text.
 */
export function enableEntryText(content: string, id: string): string {
  return setEntryDisabledText(content, id, false)
}

function setEntryDisabledText(content: string, id: string, disabled: boolean): string {
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
        out.push(`  disabled: ${disabled}`)
        index += 1
      } else {
        out.push(`  disabled: ${disabled}`)
      }
      continue
    }
    out.push(line)
  }
  if (found) return out.join('\n')
  const bracket = out.findIndex(line => line.trim() === '[]')
  const entry = [`- id: ${id}`, `  disabled: ${disabled}`]
  if (bracket !== -1) out.splice(bracket, 1, ...entry)
  else {
    // Insert before the trailing newline marker so the file keeps it.
    let insertAt = out.length
    while (insertAt > 0 && out[insertAt - 1]?.trim() === '') insertAt -= 1
    out.splice(insertAt, 0, ...entry)
  }
  return out.join('\n')
}
