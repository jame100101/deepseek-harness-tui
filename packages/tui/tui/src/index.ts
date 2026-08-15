/**
 * @deepseek-ai/dsh-tui — the in-process terminal surface over the dsh core.
 * Creates one process-wide Agent through the core registry, folds its
 * event-sourced session log into transcript rows enriched with tool
 * render-intent cards, and drives either the Ink full-screen renderer (TTY)
 * or a line-driven fallback (pipes/CI).
 *
 * The plugin registers no tools, no prompt sections, and no providers that
 * alter requests: the approval answerer and user-questions provider only
 * ANSWER interactive questions, so the request envelope stays byte-identical
 * to the surface-less composition (KV-cache-safe by construction). In the
 * non-TTY fallback no answerer mounts at all — asks fail closed, matching
 * headless-strict semantics.
 *
 * @module @deepseek-ai/dsh-tui
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type imports carry the loader/cmdline/approval/questions/commands/llm/
// tools Context merges the optional-service reads below depend on.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
// Empty import carries the workflow event-vocabulary merge the run listeners
// below consume.
import type {} from '@deepseek-ai/dsh-workflow'
// Empty imports carry the message-feedback/plan/goal Context and event
// merges the fold and the optional service reads below consume.
import type {} from '@deepseek-ai/dsh-message-feedback'
import type { MessageFeedbackItem } from '@deepseek-ai/dsh-message-feedback/types'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-attachment'
// Empty type imports carry the sandbox-policy Context merge, the
// session-projection registry merge, the token-meter `contextPressure`
// SessionProjectionMap key the publish path reads, and the app-boot
// `profilePatchPath` merge the plugin toggle writes back.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-app-boot'
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { anchorRetry, applyEvent, createScratch, foldFromLog, initialState } from './fold'
import type { FoldScratch } from './fold'
import type { FoldState } from './types'
import { renderNodePlain } from './plain'
import { disableEntryText, enableEntryText } from './patch-toggle'
import { collectCredentialRefs, collectPluginFields, groupProviders } from './settings-data'
import { createTuiStore } from './store'
import type {
  CredentialRow, GeneralSettings, JobRow, ModelEntry, PendingApproval, PendingQuestion, SessionEntry, SettingsData,
  SubagentRow, TuiStore, WorkflowRow,
} from './store'

/** Stable Cordis plugin name. */
export const name = 'tui'

/** Core services required before the surface can mount. */
export const inject = ['agents', 'agentDefaultModel', 'tools', 'settings', 'credentials', 'messageFeedback', 'sessionQuery', 'sessionTitle', 'attachments', 'sandboxPolicy']

/** Plugin config. Keeps the cache-safety contract: no surface tunables yet. */
export interface Config {}

export const Config: z<Config> = z.object({})

/** Build the identified user message every submission sends. */
function userMessage(text: string, attachments: readonly ImageAttachmentRef[] = []): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [
      { type: 'text', text },
      ...attachments.map(attachment => ({ type: 'image' as const, attachment })),
    ],
    source: { kind: 'user' },
  })
}

/** Chinese copy for a rejected feedback mutation. */
function feedbackErrorText(error: { code: string }): string {
  switch (error.code) {
    case 'session-not-found': return '会话尚未持久化，无法记录反馈'
    case 'target-not-found': return '该消息不是可评分的助手最终消息'
    case 'note-blank': return '反馈说明不能为空'
    case 'note-too-large': return '反馈说明过长'
    default: return '反馈写入失败'
  }
}

/** Image media types the attach command accepts, by file extension. */
const IMAGE_MEDIA_BY_EXT: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Process-facing facts the surface owns across publishes. */
interface Surface {
  fold: FoldState
  scratch: FoldScratch
  version: number
  busy: boolean
  agent: Agent
  selection: ModelSelectionRef
  currentModel: string
  models: ModelEntry[]
  pendingApproval: PendingApproval | null
  pendingQuestion: PendingQuestion | null
  approvalResolve: ((outcome: 'allowed-once' | 'rejected') => void) | null
  questionResolve: ((answers: { id: string; selected: string[]; custom?: string }[]) => void) | null
  /** Loaded /settings page data; refreshed on settings and credential events. */
  settings: SettingsData | null
  /** /jobs panel rows (recomputed on every publish). */
  jobs: JobRow[]
  /** /subagents panel rows (loaded at boot and on panel open). */
  subagents: SubagentRow[]
  /** /workflows panel rows, keyed by run id (event-driven). */
  workflows: Map<string, WorkflowRow>
  /** Per-message feedback by message id; replaced on every mutation. */
  feedback: Map<string, MessageFeedbackItem>
  /** Reasoning-effort selection and the current route's exposed levels. */
  reasoning: { effort: string | undefined; levels: string[] }
  /** Image attachments queued for the next user message. */
  pendingAttachments: ImageAttachmentRef[]
  /** The surface's working directory (workspace). */
  cwd: string
}

/** Read the adapter-exposed reasoning levels for one exact route. */
async function resolveReasoning(ctx: Context, provider: string, model: string): Promise<{ effort: string | undefined; levels: string[] }> {
  const llm = ctx.get('llm')
  if (llm === undefined) return { effort: undefined, levels: [] }
  try {
    const resolved = await llm.resolveModelInfo(provider, model)
    const reasoning = resolved.reasoning
    return {
      effort: reasoning?.defaultEffort === undefined ? undefined : String(reasoning.defaultEffort),
      levels: reasoning?.efforts.map(info => String(info.id)) ?? [],
    }
  } catch {
    // A route the adapter cannot resolve exposes no effort control.
    return { effort: undefined, levels: [] }
  }
}

/**
 * Read the Web-parity context occupancy for one session from the
 * token-meter's `contextPressure` projection: `projectedTokens` over the
 * newest known `contextWindow`. The projection answers for the NEXT request
 * — a compaction's surface replacement shrinks the running surface total
 * immediately, so the value drops live, exactly like the Web strip. Null
 * when the projection service (or the token-meter unit) is absent.
 * @param ctx - plugin context carrying the optional registry.
 * @param session - the surface agent's session.
 * @returns the occupancy pair, or null when unavailable.
 */
function readOccupancy(ctx: Context, session: Session): { projectedTokens: number; contextWindow: number } | null {
  const projections = ctx.get('sessionProjections') as SessionProjectionRegistry | undefined
  if (projections === undefined) return null
  try {
    const pressure = projections.snapshot(session).values.contextPressure
    if (pressure === undefined || pressure.projectedTokens === undefined || pressure.contextWindow === undefined) return null
    return { projectedTokens: pressure.projectedTokens, contextWindow: pressure.contextWindow }
  } catch {
    // A projection drive racing teardown must not disturb the surface.
    return null
  }
}

/**
 * Load the /sessions rows: live agents plus the newest 50 persisted-corpus
 * records with their latest folded titles. Fails soft to the live list when
 * the query service or any title read rejects.
 */
async function loadSessionRows(ctx: Context, liveRows: readonly SessionEntry[]): Promise<SessionEntry[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return [...liveRows]
  try {
    const records = await query.listSessions()
    const newest = records.slice(0, 50)
    const titles = await query.readTitleSnapshots(newest.map(record => record.header.id))
    const rows: SessionEntry[] = newest.map((record, index) => {
      const titleResult = titles[index]
      const title = titleResult?.status === 'fulfilled' ? titleResult.value.title?.title : undefined
      return {
        id: record.header.id,
        model: '',
        status: record.live ? 'running' : 'persisted',
        ...(title === undefined ? {} : { title }),
        live: record.live,
        persisted: record.persisted,
        createdAt: record.header.createdAt,
      }
    })
    return rows
  } catch {
    return [...liveRows]
  }
}

/** Attach the tool's presentCall/presentResult card to the folded tool row. */
function enrichToolCards(ctx: Context, event: SessionEvent, fold: FoldState): void {
  if (event.type !== 'tool/call' && event.type !== 'tool/result') return
  const tools = ctx.get('tools')
  if (tools === undefined) return
  if (event.type === 'tool/call') {
    const node = fold.nodes[fold.nodes.length - 1]
    if (node === undefined || node.kind !== 'tool') return
    const definition = tools.get(event.data.name)
    if (definition !== undefined && definition.presentCall !== undefined) {
      try {
        node.callCard = definition.presentCall(node.args) ?? null
      } catch {
        node.callCard = null
      }
    }
    return
  }
  // tool/result: enrich the just-settled row (the newest non-running tool).
  for (let index = fold.nodes.length - 1; index >= 0; index--) {
    const node = fold.nodes[index]
    if (node === undefined || node.kind !== 'tool' || node.status === 'running') continue
    const definition = tools.get(node.detail.split(' ')[0] ?? '')
    if (definition !== undefined && definition.presentResult !== undefined) {
      try {
        const result = {
          content: event.data.message.content,
          ...(event.data.error === undefined ? {} : { error: event.data.error }),
          ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
        } as unknown as Parameters<NonNullable<typeof definition.presentResult>>[1]
        node.resultCard = definition.presentResult(node.args, result) ?? null
      } catch {
        node.resultCard = null
      }
    }
    break
  }
}

/** Read pending inbox previews for the queue dock (best-effort projection). */
function queuedEntries(agent: Agent): { text: string; steer: boolean }[] {
  const inbox = agent.inbox as unknown as {
    nextTurn?: readonly { content?: readonly { type?: string; text?: string }[] }[]
    nextStep?: readonly { content?: readonly { type?: string; text?: string }[] }[]
  }
  const textOf = (message: { content?: readonly { type?: string; text?: string }[] } | undefined): string =>
    (message?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('')
      .slice(0, 60)
  return [
    ...(inbox.nextStep ?? []).map(message => ({ text: textOf(message), steer: true })),
    ...(inbox.nextTurn ?? []).map(message => ({ text: textOf(message), steer: false })),
  ]
}

/**
 * Project the /settings four pages from the live services. Credential rows
 * stay value-free: the walker reads only reference names, and
 * `credentials.describe` reports configured/source/writable without the value.
 * @param ctx - plugin context.
 * @param surface - the surface whose model routes group into the models page.
 * @param tuiScope - the registered `tui` settings scope.
 * @returns the complete settings page data.
 */
async function loadSettingsData(ctx: Context, surface: Surface, tuiScope: SettingsScope<{ busyEnter: 'queue' | 'steer'; thinking: 'collapsed' | 'expanded' }>): Promise<SettingsData> {
  const descriptors = ctx.settings.describe({ redactSecrets: true })
  const refs = new Map<string, string[]>()
  for (const descriptor of descriptors) {
    for (const slot of collectCredentialRefs(descriptor.schema, descriptor.value)) {
      if (slot.ref !== '' && !refs.has(slot.ref)) refs.set(slot.ref, slot.path)
    }
  }
  const credentialRows: CredentialRow[] = []
  for (const ref of refs.keys()) {
    try {
      const info = await ctx.credentials.describe(credentialRef(ref))
      credentialRows.push({
        ref,
        configured: info.configured,
        ...(info.source === undefined ? {} : { source: info.source }),
        writable: info.writable,
      })
    } catch {
      // A provider removed mid-read must not blank the whole page.
      credentialRows.push({ ref, configured: false, writable: false })
    }
  }
  const general = tuiScope.get() as GeneralSettings
  const inspect = ctx.get('cordisInspect') as { list(): readonly unknown[] } | undefined
  return {
    general,
    models: {
      providers: groupProviders(surface.models),
      credentials: credentialRows,
    },
    plugins: [...ctx.loader.entries()].map(entry => {
      const descriptor = descriptors.find(candidate => candidate.ns === entry.id)
      return {
        id: entry.id,
        name: entry.options.name,
        enabled: !entry.disabled,
        loaded: entry.fiber !== undefined,
        ...(descriptor === undefined ? {} : { namespace: descriptor.ns }),
      }
    }),
    configs: Object.fromEntries(descriptors.map(descriptor => [descriptor.ns, collectPluginFields(descriptor.schema, descriptor.value, general.locale)])),
    inventory: {
      namespaces: descriptors.map(descriptor => ({
        ns: descriptor.ns,
        applies: descriptor.applies,
        revision: descriptor.revision,
        secretSlots: descriptor.secrets?.length ?? 0,
        secretSet: descriptor.secrets?.filter(secret => secret.set).length ?? 0,
      })),
      credentials: credentialRows,
      inspectProviders: inspect?.list().length ?? 0,
    },
  }
}

/**
 * Project the /jobs panel rows from the live registry (sync, in-memory).
 * @param ctx - plugin context.
 * @param now - current epoch ms.
 * @returns one row per registered job.
 */
function jobsRows(ctx: Context, now: number): JobRow[] {
  const jobs = ctx.get('jobs') as { list(): readonly JobSnapshot[] } | undefined
  if (jobs === undefined) return []
  return jobs.list().map((snapshot): JobRow => ({
    id: snapshot.id,
    kind: snapshot.kind,
    label: snapshot.label,
    status: snapshot.status,
    ...(snapshot.detail === undefined ? {} : { detail: snapshot.detail }),
    elapsedMs: (snapshot.finishedAt ?? now) - snapshot.startedAt,
  }))
}

/**
 * Project the /subagents panel rows from the durable descendant tree of the
 * surface's own agent.
 * @param ctx - plugin context.
 * @param rootSessionId - the surface agent's session id.
 * @returns one row per child, depth-ordered.
 */
async function subagentRows(ctx: Context, rootSessionId: SessionId): Promise<SubagentRow[]> {
  const subagents = ctx.get('subagents') as {
    listDescendants(root: SessionId): Promise<readonly SubagentDescendantListEntry[]>
  } | undefined
  if (subagents === undefined) return []
  try {
    const entries = await subagents.listDescendants(rootSessionId)
    return entries.map((entry): SubagentRow => entry.kind === 'child'
      ? {
          id: entry.id,
          label: entry.mode === 'continuable' ? entry.label : (entry.label ?? entry.id),
          mode: entry.mode,
          activity: entry.activity,
          depth: entry.depth,
        }
      : { id: entry.id, label: entry.reason, mode: 'diagnostic', activity: 'diagnostic', depth: entry.depth })
  } catch {
    // A listing racing teardown must not blank the panel.
    return []
  }
}

/**
 * Subscribe the fold and busy status to the Cordis event world through the
 * same raw `internal/dispatch` global channel the invariant companions use,
 * refresh the settings pages on settings/credential commits, and fold the
 * workflow run events into /workflows rows.
 * @param ctx - plugin context.
 * @param store - the UI store to publish into.
 * @param surface - mutable surface facts.
 * @param refreshSettings - reloads and publishes the /settings page data.
 * @returns the disposer.
 */
function subscribe(
  ctx: Context,
  store: TuiStore,
  surface: Surface,
  refreshSettings: () => void,
): () => void {
  const publish = (): void => {
    surface.version += 1
    store.set({
      version: surface.version,
      nodes: surface.fold.nodes,
      trace: surface.fold.trace,
      todos: surface.fold.todos,
      stats: surface.fold.stats,
      live: surface.fold.live,
      busy: surface.busy || surface.agent.status === 'running',
      model: surface.currentModel,
      sessionId: surface.agent.id,
      cwd: surface.cwd,
      pendingApproval: surface.pendingApproval,
      pendingQuestion: surface.pendingQuestion,
      commands: store.getSnapshot().commands,
      models: surface.models,
      sessions: ctx.agents.list().map((agent): SessionEntry => ({
        id: agent.id,
        model: agent.options.model ?? '',
        status: agent.status,
      })),
      queued: queuedEntries(surface.agent),
      settings: surface.settings,
      jobs: jobsRows(ctx, Date.now()),
      subagents: surface.subagents,
      workflows: [...surface.workflows.values()],
      feedback: surface.feedback,
      plan: surface.fold.plan,
      goal: surface.fold.goal,
      reasoning: surface.reasoning,
      attachmentCount: surface.pendingAttachments.length,
      compaction: surface.fold.compaction,
      sandbox: ctx.sandboxPolicy.resolve({ session: surface.agent.session }).mode,
      occupancy: readOccupancy(ctx, surface.agent.session),
    })
  }
  const off = ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName === 'session/event') {
      const event = (args as unknown[])[1] as SessionEvent
      surface.fold = applyEvent(surface.fold, event, surface.scratch)
      enrichToolCards(ctx, event, surface.fold)
      anchorRetry(surface.fold, event)
      publish()
      return
    }
    if (eventName === 'agent/status') {
      const payload = (args as unknown[])[0] as { status?: unknown } | undefined
      surface.busy = payload?.status === 'running'
      publish()
    }
  }, { global: true })
  // The occupancy projection can change on the same session event the fold
  // just handled; re-publish on its change feed so the strip reflects the
  // post-compaction surface immediately, not one event later.
  const projections = ctx.get('sessionProjections') as SessionProjectionRegistry | undefined
  const offOccupancy = projections === undefined
    ? (): void => {}
    : projections.onChanged((session, key) => {
        if (key !== 'contextPressure' || session !== surface.agent.session) return
        publish()
      })
  const offSettings = ctx.on('settings/updated', refreshSettings)
  const offCredentials = ctx.on('credentials/updated', refreshSettings)
  // Workflow runs are event-driven: each event folds its facts onto one row.
  const offWorkflowStart = ctx.on('workflow/start', (info) => {
    surface.workflows.set(info.id, { id: info.id, name: info.meta.name, status: 'running', agentsStarted: 0 })
    publish()
  })
  const offWorkflowPhase = ctx.on('workflow/phase', (info, title) => {
    const row = surface.workflows.get(info.id)
    if (row !== undefined) {
      row.phase = title
      publish()
    }
  })
  const offWorkflowLog = ctx.on('workflow/log', (info, message) => {
    const row = surface.workflows.get(info.id)
    if (row !== undefined) {
      row.lastLog = message.slice(0, 200)
      publish()
    }
  })
  const offWorkflowAgentStart = ctx.on('workflow/agent-start', (info) => {
    const row = surface.workflows.get(info.id)
    if (row !== undefined) {
      row.agentsStarted += 1
      publish()
    }
  })
  const offWorkflowEnd = ctx.on('workflow/end', (info, result) => {
    const row = surface.workflows.get(info.id)
    if (row !== undefined) {
      row.status = result.stopReason === 'completed' ? 'completed' : result.stopReason === 'cancelled' ? 'cancelled' : 'error'
      if (result.error !== undefined) row.error = result.error.slice(0, 200)
      publish()
    }
  })
  publish()
  return () => {
    off()
    offSettings()
    offCredentials()
    offOccupancy()
    offWorkflowStart()
    offWorkflowPhase()
    offWorkflowLog()
    offWorkflowAgentStart()
    offWorkflowEnd()
  }
}

/** Mount the interactive answerers; in the non-TTY fallback none mount. */
function mountAnswerers(ctx: Context, store: TuiStore, surface: Surface): void {
  const approval = ctx.get('approval')
  if (approval !== undefined) {
    ctx.on('approval/request', (req, next) => {
      if (req.agent !== surface.agent) return next()
      // A second concurrent question cannot be presented; fail it closed.
      if (surface.pendingApproval !== null) return Promise.resolve('rejected' as const)
      return new Promise<'allowed-once' | 'rejected'>((resolve) => {
        surface.approvalResolve = resolve
        surface.pendingApproval = {
          toolName: req.toolName,
          ...(req.reason === undefined ? {} : { reason: req.reason }),
        }
        surface.version += 1
        store.set({ ...store.getSnapshot(), pendingApproval: surface.pendingApproval, version: surface.version })
        // The answerer race: the service settles 'cancelled' on signal abort;
        // clear the overlay so the UI does not hold a dead question.
        req.signal?.addEventListener('abort', () => {
          if (surface.pendingApproval !== null) {
            surface.pendingApproval = null
            surface.approvalResolve = null
            surface.version += 1
            store.set({ ...store.getSnapshot(), pendingApproval: null, version: surface.version })
          }
        }, { once: true })
      })
    })
  }
  const questions = ctx.get('userQuestions')
  if (questions !== undefined) {
    ctx.effect(() => questions.registerProvider({
      ask: (request) => new Promise((resolve) => {
        surface.questionResolve = (answers) => resolve({ answers })
        surface.pendingQuestion = {
          questions: request.questions.map(question => ({
            id: question.id,
            question: question.question,
            ...(question.detail === undefined ? {} : { detail: question.detail }),
            ...(question.options === undefined ? {} : { options: question.options }),
            ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
          })),
        }
        surface.version += 1
        store.set({ ...store.getSnapshot(), pendingQuestion: surface.pendingQuestion, version: surface.version })
        request.signal?.addEventListener('abort', () => {
          if (surface.pendingQuestion !== null) {
            surface.pendingQuestion = null
            surface.questionResolve = null
            surface.version += 1
            store.set({ ...store.getSnapshot(), pendingQuestion: null, version: surface.version })
          }
        }, { once: true })
      }),
    }))
  }
}

/** Request process exit through the launcher-provided host value. */
function exitProcess(ctx: Context): void {
  ctx.get('appExit')?.(0)
}

/** Report a boot or surface failure and request a failing exit. */
function fail(ctx: Context, error: unknown): void {
  console.error(`dsh: ${error instanceof Error ? error.message : String(error)}`)
  exitProcess(ctx)
}

/** Discover the selectable model routes from the registered LLM adapters. */
async function loadModels(ctx: Context, current: { provider: string; model: string }): Promise<ModelEntry[]> {
  const llm = ctx.get('llm')
  if (llm === undefined) return [{ provider: current.provider, model: current.model, label: `${current.provider}/${current.model}` }]
  const entries: ModelEntry[] = []
  for (const provider of llm.listProviders()) {
    try {
      const models = await llm.listModels(provider.id)
      for (const model of models) {
        entries.push({ provider: provider.id, model: model.id, label: model.name === model.id ? model.id : `${model.name} (${model.id})` })
      }
    } catch {
      // A provider that cannot list models still routes; skip its catalog.
    }
  }
  if (entries.length === 0) {
    entries.push({ provider: current.provider, model: current.model, label: `${current.provider}/${current.model}` })
  }
  return entries
}

/** Create one agent over the current default-model selection. */
async function createAgent(ctx: Context, cwd: string): Promise<{ agent: Agent; handle: AgentHandle; selection: ModelSelection; ref: ModelSelectionRef }> {
  const selection = ctx.agentDefaultModel.currentSelection()
  const ref: ModelSelectionRef = { current: selection, assembled: undefined }
  const handle = await ctx.agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, ref)
    },
  })
  return { agent: handle.agent, handle, selection, ref }
}

/**
 * Create the agent, mount the store and answerers, and drive the matching
 * surface until it exits.
 * @param ctx - plugin context carrying the agent registry, default model, tool registry, settings, and credentials.
 * @param tuiScope - the registered `tui` settings namespace scope.
 */
async function boot(
  ctx: Context,
  tuiScope: SettingsScope<{ busyEnter: 'queue' | 'steer'; thinking: 'collapsed' | 'expanded' }>,
): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const created = await createAgent(ctx, process.cwd())
  const hostCommands = ctx.get('commands')?.list(created.agent) ?? []
  const commandEntries = hostCommands.map(command => ({
    name: command.name,
    description: command.description,
    needsArgs: command.input !== undefined,
  }))
  const models = await loadModels(ctx, created.selection)
  const store = createTuiStore({
    version: 0,
    nodes: [],
    trace: [],
    todos: [],
    stats: initialState().stats,
    live: null,
    busy: false,
    model: created.selection.model,
    sessionId: created.agent.id,
    cwd: process.cwd(),
    pendingApproval: null,
    pendingQuestion: null,
    commands: commandEntries,
    models,
    sessions: [],
    queued: [],
    settings: null,
    jobs: [],
    subagents: [],
    workflows: [],
    feedback: new Map(),
    plan: { active: false, pending: false },
    goal: null,
    reasoning: { effort: undefined, levels: [] },
    attachmentCount: 0,
    compaction: false,
    sandbox: ctx.sandboxPolicy.resolve({ session: created.agent.session }).mode,
    occupancy: null,
  })
  const surface: Surface = {
    fold: initialState(),
    scratch: createScratch(),
    version: 0,
    busy: false,
    agent: created.agent,
    selection: created.ref,
    currentModel: created.selection.model,
    models,
    pendingApproval: null,
    pendingQuestion: null,
    approvalResolve: null,
    questionResolve: null,
    settings: null,
    jobs: [],
    subagents: [],
    workflows: new Map(),
    feedback: new Map(),
    reasoning: {
      effort: created.selection.reasoningEffort === undefined ? undefined : String(created.selection.reasoningEffort),
      levels: [],
    },
    pendingAttachments: [],
    cwd: process.cwd(),
  }
  void resolveReasoning(ctx, created.selection.provider, created.selection.model).then((reasoning) => {
    // The persisted selection's own effort wins over the adapter default.
    surface.reasoning = {
      effort: created.selection.reasoningEffort === undefined ? reasoning.effort : String(created.selection.reasoningEffort),
      levels: reasoning.levels,
    }
    surface.version += 1
    store.set({ ...store.getSnapshot(), reasoning: surface.reasoning, version: surface.version })
  }).catch(() => {})
  /** Publish one replaced feedback map. */
  const publishFeedback = (): void => {
    surface.version += 1
    store.set({ ...store.getSnapshot(), feedback: surface.feedback, version: surface.version })
  }
  /** Load durable feedback for the live session (best-effort sidecar read). */
  const loadFeedback = async (): Promise<void> => {
    const service = ctx.get('messageFeedback')
    if (service === undefined) return
    try {
      const result = await service.list({ sessionId: surface.agent.id })
      if (result.ok) {
        surface.feedback = new Map(result.value.items.map(item => [item.messageId, item]))
        publishFeedback()
      }
    } catch {
      // A sidecar read racing teardown must not disturb the surface.
    }
  }
  void loadFeedback()
  surface.settings = await loadSettingsData(ctx, surface, tuiScope)
  void subagentRows(ctx, surface.agent.id).then((rows) => {
    surface.subagents = rows
    surface.version += 1
    store.set({ ...store.getSnapshot(), subagents: rows, version: surface.version })
  }).catch(() => {
    // A listing racing teardown must not disturb the exit path.
  })
  const bootLiveRows: SessionEntry[] = ctx.agents.list().map((agent): SessionEntry => ({
    id: agent.id,
    model: agent.options.model ?? '',
    status: agent.status,
  }))
  void loadSessionRows(ctx, bootLiveRows).then((rows) => {
    surface.version += 1
    store.set({ ...store.getSnapshot(), sessions: rows, version: surface.version })
  }).catch(() => {
    // A corpus listing racing teardown must not disturb the exit path.
  })
  /** Reload the /settings pages after any settings or credential commit. */
  const refreshSettings = (): void => {
    void loadSettingsData(ctx, surface, tuiScope).then((data) => {
      surface.settings = data
      surface.version += 1
      store.set({ ...store.getSnapshot(), settings: data, version: surface.version })
    }).catch(() => {
      // A refresh racing service teardown must not disturb the exit path.
    })
  }
  let unsubscribe = subscribe(ctx, store, surface, refreshSettings)
  const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true
  if (isTty) mountAnswerers(ctx, store, surface)
  /** Host-command passthrough: registered slash commands dispatch without a model turn; unknown lines go to the model. */
  const dispatchOrFollowup = (text: string, steer: boolean): void => {
    const submit = (): void => {
      const message = userMessage(text, surface.pendingAttachments)
      surface.pendingAttachments = []
      if (steer) surface.agent.steer(message)
      else surface.agent.followup(message)
    }
    if (!text.startsWith('/')) {
      submit()
      return
    }
    const commands = ctx.get('commands')
    if (commands === undefined) {
      submit()
      return
    }
    void commands.execute(surface.agent, text, new AbortController().signal).then((execution) => {
      if (execution !== undefined) return
      submit()
    }).catch(() => { submit() })
  }
  /** Swap the surface onto a freshly created agent (/new). */
  const newSession = async (): Promise<void> => {
    try {
      const next = await createAgent(ctx, surface.cwd)
      unsubscribe()
      await created.handle.dispose()
      surface.fold = initialState()
      surface.scratch = createScratch()
      surface.agent = next.agent
      surface.selection = next.ref
      surface.currentModel = next.selection.model
      surface.pendingApproval = null
      surface.pendingQuestion = null
      surface.feedback = new Map()
      surface.pendingAttachments = []
      unsubscribe = subscribe(ctx, store, surface, refreshSettings)
      void loadFeedback()
    } catch (error) {
      fail(ctx, error)
    }
  }
  /** Resume one persisted session onto the surface; rebuilds the transcript from its log. */
  const resumeSession = async (id: string): Promise<string | null> => {
    try {
      const selected = surface.selection.current ?? ctx.agentDefaultModel.currentSelection()
      const selection: ModelSelection = {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
      }
      const ref: ModelSelectionRef = { current: selection, assembled: undefined }
      const next = await ctx.agents.resume({
        resumeSessionId: SessionId(id),
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        },
        setup: (agentCtx) => { installModelSelection(agentCtx, ref) },
      })
      unsubscribe()
      await created.handle.dispose()
      // Fold from the authoritative corpus read (persistence repair and
      // replay validation included) so the resumed transcript shows the
      // complete history; the agent's in-memory log is the fallback.
      let events: readonly SessionEvent[] = next.agent.session.events
      const query = ctx.get('sessionQuery')
      if (query !== undefined) {
        try {
          events = (await query.readSession(SessionId(id))).events
        } catch {
          // The in-memory log remains the best available surface.
        }
      }
      const { fold, scratch } = foldFromLog(events)
      surface.fold = fold
      surface.scratch = scratch
      surface.agent = next.agent
      surface.selection = ref
      surface.currentModel = next.agent.options.model ?? surface.currentModel
      surface.pendingApproval = null
      surface.pendingQuestion = null
      surface.feedback = new Map()
      surface.pendingAttachments = []
      unsubscribe = subscribe(ctx, store, surface, refreshSettings)
      void loadFeedback()
      return null
    } catch (error) {
      return `恢复失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
  try {
    if (isTty) {
      const { runInk } = await import('./render')
      await runInk(store, {
        submit: (text, steer) => { dispatchOrFollowup(text, steer) },
        cancel: () => { surface.agent.cancel({ kind: 'user' }) },
        exit: () => {
          // Cancel first so whenIdle in the teardown settles promptly even
          // when the user quits mid-turn; nothing here may throw, or the
          // launcher's teardown race escalates into a failing exit code.
          try { surface.agent.cancel({ kind: 'user' }) } catch {}
          exitProcess(ctx)
        },
        newSession: () => { void newSession() },
        resumeSession: resumeSession,
        renameSession: async (title) => {
          const service = ctx.get('sessionTitle') as { rename(session: unknown, title: string): unknown } | undefined
          try {
            service?.rename(surface.agent.session, title)
            return null
          } catch (error) {
            return `重命名失败：${error instanceof Error ? error.message : String(error)}`
          }
        },
        changeWorkspace: async (path) => {
          try {
            const target = resolve(path)
            const { statSync } = await import('node:fs')
            if (!statSync(target).isDirectory()) return '目标不是目录'
            process.chdir(target)
            surface.cwd = target
            surface.version += 1
            store.set({ ...store.getSnapshot(), cwd: target, version: surface.version })
            return null
          } catch (error) {
            return `切换失败：${error instanceof Error ? error.message : String(error)}`
          }
        },
        attachFile: async (path) => {
          const attachments = ctx.get('attachments')
          if (attachments === undefined) return '附件服务未加载（bundle 缺 dsh-attachment-local）'
          try {
            const bytes = readFileSync(resolve(path))
            const mediaType = IMAGE_MEDIA_BY_EXT[extname(path).slice(1).toLowerCase()]
            if (mediaType === undefined) return '仅支持图片附件（png/jpg/gif/webp）'
            const ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType, name: basename(path) })
            surface.pendingAttachments = [...surface.pendingAttachments, ref]
            surface.version += 1
            store.set({ ...store.getSnapshot(), attachmentCount: surface.pendingAttachments.length, version: surface.version })
            return null
          } catch (error) {
            return `附加失败：${error instanceof Error ? error.message : String(error)}`
          }
        },
        forkSession: async (atSeq) => {
          try {
            const events = surface.agent.session.events
            const lastSeq = events.at(-1)?.seq ?? -1
            const anchored = atSeq === undefined
              ? undefined
              : events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
            const boundary = anchored
              ?? (atSeq === undefined || atSeq > lastSeq
                ? events.findLast(event => event.type === 'turn/end')
                : undefined)
            if (boundary === undefined) return '没有已完成回合可分叉'
            let cut = boundary.seq + 1
            while (cut < events.length && events[cut]?.type !== 'turn/start') cut++
            const selection: ModelSelection = surface.selection.current ?? ctx.agentDefaultModel.currentSelection()
            const ref: ModelSelectionRef = { current: selection, assembled: undefined }
            await ctx.agents.create({
              sessionId: SessionId(`session-${randomUUID()}`),
              seed: events.slice(0, cut),
              meta: { cwd: surface.cwd, parentSession: surface.agent.id, seedLength: cut },
              agentOptions: {
                provider: selection.provider,
                model: selection.model,
                ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
              },
              setup: (agentCtx) => { installModelSelection(agentCtx, ref) },
            })
            return null
          } catch (error) {
            return `分叉失败：${error instanceof Error ? error.message : String(error)}`
          }
        },
        selectModel: (provider, model, reasoningEffort) => {
          const effort = reasoningEffort === undefined ? undefined : ReasoningEffortId(reasoningEffort)
          surface.selection.current = {
            provider,
            model,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          }
          surface.currentModel = model
          void ctx.agentDefaultModel.saveSelection(surface.selection.current)
          surface.reasoning = {
            effort: effort === undefined ? undefined : String(effort),
            levels: surface.reasoning.levels,
          }
          surface.version += 1
          store.set({ ...store.getSnapshot(), model, reasoning: surface.reasoning, version: surface.version })
          void resolveReasoning(ctx, provider, model).then((reasoning) => {
            surface.reasoning = {
              effort: effort === undefined ? reasoning.effort : String(effort),
              levels: reasoning.levels,
            }
            surface.version += 1
            store.set({ ...store.getSnapshot(), reasoning: surface.reasoning, version: surface.version })
          }).catch(() => {})
        },
        setEffort: (effort) => {
          // `/effort off|high|max`: set (or clear, for off) the persisted
          // reasoning effort on the current default route.
          const selected = surface.selection.current ?? ctx.agentDefaultModel.currentSelection()
          const reasoningEffort = effort === undefined ? undefined : ReasoningEffortId(effort)
          surface.selection.current = {
            provider: selected.provider,
            model: selected.model,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          }
          surface.currentModel = selected.model
          void ctx.agentDefaultModel.saveSelection(surface.selection.current)
          surface.reasoning = { effort, levels: surface.reasoning.levels }
          surface.version += 1
          store.set({ ...store.getSnapshot(), reasoning: surface.reasoning, version: surface.version })
        },
        cycleSandbox: () => {
          // Shift+Tab: rotate the session's file-policy override. Appending
          // the `sandbox/mode` event dispatches through the fold subscription
          // and republishes the status bar immediately.
          const current = ctx.sandboxPolicy.resolve({ session: surface.agent.session }).mode
          const index = SANDBOX_MODES.indexOf(current)
          const next = SANDBOX_MODES[(index + 1) % SANDBOX_MODES.length] ?? 'read-only'
          setSandboxMode(surface.agent.session, next)
          return next
        },
        togglePlugin: async (id) => {
          // The plugins-page switch writes the profile's live user patch
          // layer; the launcher's HMR watch hot-applies the file, so the
          // toggle takes effect without a restart.
          if (id === name) {
            return { error: '不能关闭 TUI 本身（会终止当前界面）；请直接编辑 cordis.patch.yml 后重启' }
          }
          const patchPath = ctx.get('profilePatchPath')
          if (patchPath === undefined) {
            return { error: '当前启动方式没有可热改的用户 patch 层（需要 --profile），无法切换插件开关' }
          }
          try {
            const entry = [...ctx.loader.entries()].find(candidate => candidate.id === id)
            const enabling = entry?.disabled === true
            const content = readFileSync(patchPath, 'utf8')
            const next = enabling ? enableEntryText(content, id) : disableEntryText(content, id)
            if (next === content) return { enabled: !enabling }
            writeFileSync(patchPath, next, 'utf8')
            // The HMR watcher re-applies the layer asynchronously; refresh the
            // plugins page once the reload has settled (plus a slow-loader
            // safety net) so the ●/○ dot flips live.
            setTimeout(() => { refreshSettings() }, 600)
            setTimeout(() => { refreshSettings() }, 1500)
            setTimeout(() => { refreshSettings() }, 4000)
            return { enabled: enabling }
          } catch (error) {
            return { error: `切换失败：${error instanceof Error ? error.message : String(error)}` }
          }
        },
        approve: (outcome) => {
          surface.pendingApproval = null
          const resolve = surface.approvalResolve
          surface.approvalResolve = null
          surface.version += 1
          store.set({ ...store.getSnapshot(), pendingApproval: null, version: surface.version })
          resolve?.(outcome)
        },
        answerQuestion: (answers) => {
          surface.pendingQuestion = null
          const resolve = surface.questionResolve
          surface.questionResolve = null
          surface.version += 1
          store.set({ ...store.getSnapshot(), pendingQuestion: null, version: surface.version })
          resolve?.([...answers])
        },
        updateSetting: patch => ctx.settings.update(settingsNamespace('tui'), patch as object),
        updatePluginConfig: async (ns, patch) => {
          try {
            await ctx.settings.update(settingsNamespace(ns), patch as object)
            return null
          } catch (error) {
            return `写入失败：${error instanceof Error ? error.message : String(error)}`
          }
        },
        setCredential: (ref, value) => ctx.credentials.set(credentialRef(ref), value),
        unsetCredential: ref => ctx.credentials.unset(credentialRef(ref)),
        refreshPanels: () => {
          surface.jobs = jobsRows(ctx, Date.now())
          surface.version += 1
          store.set({ ...store.getSnapshot(), jobs: surface.jobs, version: surface.version })
          void subagentRows(ctx, surface.agent.id).then((rows) => {
            surface.subagents = rows
            surface.version += 1
            store.set({ ...store.getSnapshot(), subagents: rows, version: surface.version })
          }).catch(() => {})
          const liveRows: SessionEntry[] = ctx.agents.list().map((agent): SessionEntry => ({
            id: agent.id,
            model: agent.options.model ?? '',
            status: agent.status,
          }))
          void loadSessionRows(ctx, liveRows).then((rows) => {
            surface.version += 1
            store.set({ ...store.getSnapshot(), sessions: rows, version: surface.version })
          }).catch(() => {})
        },
        killJob: (id) => {
          const jobs = ctx.get('jobs') as { kill(jobId: JobId, caller?: Agent, reason?: string): string } | undefined
          try { jobs?.kill(JobId(id), surface.agent) } catch {}
          surface.jobs = jobsRows(ctx, Date.now())
          surface.version += 1
          store.set({ ...store.getSnapshot(), jobs: surface.jobs, version: surface.version })
        },
        rateMessage: async (messageId, rating) => {
          const service = ctx.get('messageFeedback')
          if (service === undefined) return '消息反馈服务未加载（bundle 缺 dsh-message-feedback）'
          const sessionId = surface.agent.id
          const current = surface.feedback.get(messageId)
          // Rating the same value again removes the item (Web toggle parity).
          if (current !== undefined && current.rating === rating) {
            const result = await service.delete({ sessionId, messageId: MessageId(messageId), ifVersion: current.version })
            if (result.ok) {
              surface.feedback = new Map(surface.feedback)
              surface.feedback.delete(messageId)
              publishFeedback()
              return null
            }
            if (result.error.code === 'version-conflict') {
              await loadFeedback()
              return null
            }
            return feedbackErrorText(result.error)
          }
          const result = await service.put({
            sessionId,
            messageId: MessageId(messageId),
            rating,
            ifVersion: current?.version ?? null,
          })
          if (result.ok) {
            surface.feedback = new Map(surface.feedback)
            surface.feedback.set(messageId, result.value)
            publishFeedback()
            return null
          }
          if (result.error.code === 'version-conflict') {
            // Someone else changed the item: re-apply against the
            // authoritative current value exactly once.
            const retry = await service.put({
              sessionId,
              messageId: MessageId(messageId),
              rating,
              ifVersion: result.error.current?.version ?? null,
            })
            if (retry.ok) {
              surface.feedback = new Map(surface.feedback)
              surface.feedback.set(messageId, retry.value)
              publishFeedback()
              return null
            }
            if (retry.error.code === 'version-conflict') {
              await loadFeedback()
              return null
            }
            return feedbackErrorText(retry.error)
          }
          return feedbackErrorText(result.error)
        },
      })
    } else {
      const { runLegacy } = await import('./legacy')
      await runLegacy({
        onPrompt: async (text) => {
          const firstCount = store.getSnapshot().nodes.length
          dispatchOrFollowup(text, false)
          await surface.agent.whenIdle()
          const nodes = store.getSnapshot().nodes
          for (const node of nodes.slice(firstCount)) {
            const rendered = renderNodePlain(node)
            if (rendered !== '') process.stdout.write(rendered + '\n')
          }
        },
        onExit: () => exitProcess(ctx),
      })
    }
  } catch (error) {
    fail(ctx, error)
  } finally {
    try { unsubscribe() } catch {}
    try { await surface.agent.whenIdle() } catch {}
  }
}

/**
 * Mount the TUI surface and register its settings namespace (`tui` in
 * `$DSH_HOME/settings.yaml`): busyEnter and the thinking display default.
 * Registering a namespace does not touch the request envelope, so the
 * cache-safety contract stands.
 * @param ctx - plugin context carrying the agent registry, default model, tool registry, settings, and credentials.
 * @param _config - validated (currently empty) plugin config.
 */
export function apply(ctx: Context, _config: Config): void {
  const tuiScope = ctx.settings.register(settingsNamespace('tui'), z.object({
    busyEnter: z.union(['queue', 'steer']).default('queue'),
    thinking: z.union(['collapsed', 'expanded']).default('collapsed'),
    theme: z.union(['dark', 'light']).default('dark'),
    locale: z.union(['zh', 'en']).default('zh'),
  }))
  void boot(ctx, tuiScope).catch((error: unknown) => { fail(ctx, error) })
}
