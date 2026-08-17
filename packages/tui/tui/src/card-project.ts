/**
 * Render-intent card projection: the pure functions that turn a tool's
 * `presentCall`/`presentResult` views into terminal lines. One projector per
 * card family (generic / terminal / diff / search / read / web); unknown
 * views fall back to the documented default (opaque text). Pure of the
 * session context and of Ink.
 * @module @deepseek-ai/dsh-tui/src/card-project
 */

import type {
  DiffCallView,
  DiffResultView,
  GenericCallView,
  GenericResultView,
  ReadResultView,
  SearchMatchesResultView,
  SearchPathsResultView,
  TerminalCallView,
  TerminalResultView,
  ToolCallView,
  ToolResultView,
  WebFetchResultView,
  WebSearchResultView,
} from '@deepseek-ai/dsh-tools/presentation'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** One colored line of a projected card. */
export interface CardLine {
  text: string
  color?: 'green' | 'red' | 'yellow' | 'cyan' | 'gray' | 'magenta'
}

/** Cap on projected card lines, so a giant card cannot flood the transcript. */
const MAX_CARD_LINES = 200
/** Cap on one card source line: a single-line JSON blob must not wrap into hundreds of rows. */
const MAX_CARD_LINE_LENGTH = 300

/** Truncate one over-long source line so wrapping stays bounded. */
function capLine(text: string): string {
  return text.length <= MAX_CARD_LINE_LENGTH ? text : `${text.slice(0, MAX_CARD_LINE_LENGTH)}…`
}

/** Flatten harness content blocks into plain text (tool-result blocks recurse). */
function blocksText(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text') out += block.text
    else if (block.type === 'tool-result') out += blocksText(block.content)
  }
  return out
}

/** Split text into card lines without width-aware wrapping (the renderer wraps). */
function lines(text: string, cap = MAX_CARD_LINES): CardLine[] {
  const split = text === '' ? [] : text.split('\n')
  return split.slice(0, cap).map(line => ({ text: capLine(line) }))
}

/** Color one +/- diff line. */
function diffLine(text: string): CardLine {
  if (text.startsWith('+') && !text.startsWith('+++')) return { text, color: 'green' }
  if (text.startsWith('-') && !text.startsWith('---')) return { text, color: 'red' }
  if (text.startsWith('@@')) return { text, color: 'cyan' }
  return { text, color: 'gray' }
}

/** Project one pending-call view into card lines. */
export function projectCallCard(view: ToolCallView | null, fallbackDetail: string): CardLine[] {
  if (view === null) return []
  switch (view.card) {
    case 'terminal': {
      const terminal = view as TerminalCallView
      const out: CardLine[] = []
      if (terminal.description !== undefined && terminal.description !== '') out.push({ text: terminal.description, color: 'gray' })
      if (terminal.cwd !== undefined) out.push({ text: `cwd: ${terminal.cwd}`, color: 'gray' })
      out.push({ text: `$ ${terminal.title}`, color: 'cyan' })
      return out
    }
    case 'diff': {
      const diff = view as DiffCallView
      const out: CardLine[] = []
      for (const file of diff.diffs) {
        out.push({ text: `── ${file.path}${file.oldText === null ? ' (new)' : ''}`, color: 'gray' })
        for (const line of lines(file.newText).slice(0, 80)) out.push(diffLine(`+${line.text}`))
      }
      return out.slice(0, MAX_CARD_LINES)
    }
    case 'generic': {
      const generic = view as GenericCallView
      const out: CardLine[] = [{ text: `${generic.title}${generic.kind !== undefined ? ` [${generic.kind}]` : ''}`, color: 'gray' }]
      if (generic.rawInput !== undefined) {
        const rendered = typeof generic.rawInput === 'string' ? generic.rawInput : JSON.stringify(generic.rawInput)
        out.push(...lines(rendered).map(line => ({ text: `  ${line.text}`, color: 'gray' as const })))
      }
      if (generic.content !== undefined) {
        out.push(...lines(blocksText(generic.content)).map(line => ({ text: `  ${line.text}`, color: 'gray' as const })))
      }
      if (generic.locations !== undefined && generic.locations.length > 0) {
        out.push({
          text: `  files: ${generic.locations.map(location => `${location.path}${location.line === undefined ? '' : `:${location.line}`}`).join(', ')}`,
          color: 'gray',
        })
      }
      return out
    }
    default:
      return [{ text: fallbackDetail, color: 'gray' }]
  }
}

/** Project one completed-call view into card lines. */
export function projectResultCard(view: ToolResultView | null, fallbackText: string): CardLine[] {
  if (view === null) {
    return fallbackText === '' ? [] : lines(fallbackText).map(line => ({ text: `  ${line.text}`, color: 'gray' as const }))
  }
  switch (view.card) {
    case 'terminal': {
      const terminal = view as TerminalResultView
      const out: CardLine[] = []
      if (terminal.output !== undefined && terminal.output !== '') out.push(...lines(terminal.output))
      const status: CardLine = terminal.exitCode !== undefined
        ? { text: `exit ${terminal.exitCode}`, color: terminal.exitCode === 0 ? 'green' : 'red' }
        : terminal.signal !== undefined
          ? { text: `killed by ${terminal.signal}`, color: 'yellow' }
          : { text: 'done', color: 'green' }
      out.push(status)
      return out.slice(0, MAX_CARD_LINES)
    }
    case 'diff': {
      const diff = view as DiffResultView
      const out: CardLine[] = []
      for (const file of diff.diffs) {
        out.push({ text: `── ${file.path}${file.oldText === null ? ' (new)' : ''}`, color: 'gray' })
        if (file.oldText !== null) {
          for (const line of lines(file.oldText).slice(0, 80)) out.push(diffLine(`-${line.text}`))
        }
        for (const line of lines(file.newText).slice(0, 80)) out.push(diffLine(`+${line.text}`))
      }
      return out.slice(0, MAX_CARD_LINES)
    }
    case 'search': {
      const search = view as SearchMatchesResultView | SearchPathsResultView
      const out: CardLine[] = []
      if (search.shape === 'matches') {
        for (const file of search.files) {
          out.push({ text: `── ${file.path}`, color: 'gray' })
          for (const match of file.matches) {
            out.push({ text: `  ${match.lineNumber}: ${match.line}`, color: 'gray' })
          }
        }
      } else {
        for (const path of search.paths) out.push({ text: `  ${path}`, color: 'gray' })
      }
      out.push({
        text: search.truncated ? `… 已截断（显示 ${search.shape === 'matches' ? search.files.length : search.paths.length}/${search.total}）` : `共 ${search.total} 项`,
        color: 'yellow',
      })
      return out.slice(0, MAX_CARD_LINES)
    }
    case 'read': {
      const read = view as ReadResultView
      const out: CardLine[] = [{ text: `── ${read.path} (${read.offset}–${read.offset + read.lines.length - 1} of ${read.totalLines} 行)`, color: 'gray' }]
      for (const line of read.lines) out.push({ text: `${line.number}: ${line.text}`, color: 'gray' })
      if (read.lines.length === 0) out.push({ text: '  (empty window)', color: 'gray' })
      if (read.content !== undefined && read.lines.length === 0) out.push(...lines(blocksText(read.content)))
      return out.slice(0, MAX_CARD_LINES)
    }
    case 'web': {
      const web = view as WebSearchResultView | WebFetchResultView
      const out: CardLine[] = []
      if (web.kind === 'search') {
        if (web.answer !== undefined && web.answer !== '') out.push(...lines(web.answer))
        for (const source of web.sources) {
          out.push({
            text: `· ${source.title ?? source.url}${source.snippet !== undefined && source.snippet !== '' ? ` — ${source.snippet}` : ''}`,
            color: 'cyan',
          })
          out.push({ text: `  ${source.url}`, color: 'gray' })
        }
        if (web.truncated) out.push({ text: '… 来源列表已截断', color: 'yellow' })
      } else {
        out.push({ text: `${web.url} → HTTP ${web.statusCode}`, color: 'cyan' })
        if (web.truncated) out.push({ text: '… 内容已截断', color: 'yellow' })
      }
      return out.slice(0, MAX_CARD_LINES)
    }
    case 'generic': {
      const generic = view as GenericResultView
      const content = generic.content === undefined ? fallbackText : blocksText(generic.content)
      return content === '' ? [] : lines(content).map(line => ({ text: `  ${line.text}`, color: 'gray' as const }))
    }
    default:
      return fallbackText === '' ? [] : lines(fallbackText).map(line => ({ text: `  ${line.text}`, color: 'gray' as const }))
  }
}

/** Re-exported for the renderer's pending/result dispatch. */
export type { ToolCallView, ToolResultView }
