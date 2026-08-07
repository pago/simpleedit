import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import { dirname } from 'path'
import type { WebContents } from 'electron'
import type { Tour, WorktreeInfo } from '../shared/ipc-types'
import { saveTour, tourKey } from './tour'
import { getWorktreeForTerminal } from './claude-stream'
import { validateSpec, validateSpecActions } from './gen-ui-validate'
import { parseHookBody, matchWorktree, terminalForSession, type HookSignal } from './cwd-tracker'
import {
  awaitSpawn,
  captureImplicitReplies,
  drain,
  enqueue,
  peekPending,
  formatForDelivery,
  listPeers,
  pendingCount,
  senderOf,
  waitForReply,
  type Message,
} from './agent-bus'

interface BridgeInstance {
  server: Server
  port: number
  token: string
  webContents: WebContents
}

const bridges = new Map<number, BridgeInstance>()

/**
 * Resolves the worktree list for a window. Registered by index.ts (which owns
 * the per-window repo map) so the bridge can map a hook's cwd → worktree and
 * validate `open_worktree` targets without importing the renderer-facing repo
 * routing. Stays null in unit tests that don't need worktree resolution.
 */
type WorktreeResolver = (webContentsId: number) => Promise<WorktreeInfo[]>
let worktreeResolver: WorktreeResolver | null = null

export function setWorktreeResolver(resolver: WorktreeResolver): void {
  worktreeResolver = resolver
}

async function resolveWorktrees(webContentsId: number): Promise<WorktreeInfo[]> {
  if (!worktreeResolver) return []
  try {
    return await worktreeResolver(webContentsId)
  } catch {
    return []
  }
}

/**
 * Resolves the bare repo for a cwd the window hasn't opened yet, registers it
 * with the window, and returns its worktree list — the fallback when
 * `matchWorktree` misses because the agent roamed into a fresh repo. Registered
 * by index.ts (which owns the per-window repo map); null in unit tests.
 */
type RepoDiscoverer = (
  webContentsId: number,
  cwd: string,
) => Promise<{ repoPath: string; worktrees: WorktreeInfo[] } | null>
let repoDiscoverer: RepoDiscoverer | null = null

export function setRepoDiscoverer(discoverer: RepoDiscoverer): void {
  repoDiscoverer = discoverer
}

async function discoverRepo(
  webContentsId: number,
  cwd: string,
): Promise<{ repoPath: string; worktrees: WorktreeInfo[] } | null> {
  if (!repoDiscoverer) return null
  try {
    return await repoDiscoverer(webContentsId, cwd)
  } catch {
    return null
  }
}

interface ToolCallPayload {
  tool: string
  args: Record<string, unknown>
  terminalId: string
}

/**
 * How long `send_message(wait_for_reply)` parks. Must stay comfortably under the
 * agent's own MCP tool timeout (we raise `MCP_TOOL_TIMEOUT` at spawn) so a slow
 * peer surfaces as our explanatory `timed_out` result rather than the CLI
 * killing the tool call with a generic error.
 */
const DEFAULT_REPLY_WAIT_S = 300
const MAX_REPLY_WAIT_S = 600

/**
 * How long to wait for the renderer to report a spawned session's real id. This
 * is a local IPC round-trip plus a store insert (sub-100ms in practice), so the
 * budget is generous — but bounded, because on the degraded path the agent is
 * sitting in a tool call and we would rather hand it the "use list_sessions"
 * fallback quickly than stall it.
 */
const SPAWN_HANDLE_WAIT_MS = 1500

/**
 * Mirror every message to the renderer so the exchange is visible to the user.
 * Two agents talking with no UI trace is the failure mode to avoid.
 */
function notifyMessage(webContents: WebContents, message: Message): void {
  if (webContents.isDestroyed()) return
  webContents.send('agent-message:sent', {
    messageId: message.id,
    from: message.from,
    fromLabel: message.fromLabel,
    to: message.to,
    text: message.text,
    expectsReply: message.expectsReply,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function jsonResponse(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// -- Tool call handling ----------------------------------------

async function handleToolCall(payload: ToolCallPayload, webContents: WebContents): Promise<{ status: number; body: Record<string, unknown> }> {
  const { tool, args, terminalId } = payload

  if (tool === 'complete_task') {
    const tour = args['tour'] as Tour | undefined
    const agentWorktreePath = args['worktreePath'] as string | undefined
    const commitHashArg = args['commitHash']
    const openQuestions = args['openQuestions'] as string[] | undefined

    if (!tour) {
      return { status: 400, body: { error: 'complete_task requires tour in args' } }
    }

    const worktreePath = getWorktreeForTerminal(terminalId) ?? agentWorktreePath
    if (!worktreePath) {
      return { status: 400, body: { error: 'Could not determine worktree path for this terminal' } }
    }

    const commitHash: string | null = typeof commitHashArg === 'string' && commitHashArg ? commitHashArg : null

    // Assign stable topic ids so Svelte's keyed iteration and segment toggle state work correctly —
    // the MCP schema doesn't carry ids because they're not meaningful to the agent.
    const keyPrefix = tourKey(worktreePath, commitHash)
    const topicsWithIds = tour.topics.map((t, i) => ({ ...t, id: `${keyPrefix}:topic-${i}` }))

    const persistedTour: Tour = { ...tour, topics: topicsWithIds }
    if (openQuestions && openQuestions.length > 0) {
      persistedTour.openQuestions = openQuestions
    } else {
      delete persistedTour.openQuestions
    }

    saveTour(worktreePath, commitHash, persistedTour)

    const key = tourKey(worktreePath, commitHash)
    if (!webContents.isDestroyed()) {
      webContents.send('tour:from-agent', {
        key,
        terminalId,
        worktreePath,
        commitHash,
        tour: persistedTour,
      })
    } else {
      console.warn(`[MCP Bridge] webContents is destroyed, cannot send tour:from-agent IPC`)
    }

    return { status: 200, body: { ok: true } }
  }

  if (tool === 'show_panel') {
    const agentWorktreePath = typeof args['worktreePath'] === 'string' ? (args['worktreePath'] as string) : undefined
    const title = typeof args['title'] === 'string' ? (args['title'] as string) : 'Agent panel'

    // Agent argument first, then validate against the window's registered
    // worktrees — the same rule as show_diff. The terminal→worktree map is
    // written once in attachToTerminal and frozen at session start, so
    // preferring it silently ignored a worktreePath naming another repo and
    // rendered the panel against the wrong one. The registered-repo union is
    // the trust boundary instead; it grows at runtime as the agent touches
    // files in sibling repos (PostToolUse hook → discoverRepo).
    const worktreePath = agentWorktreePath ?? getWorktreeForTerminal(terminalId)
    if (!worktreePath) {
      return { status: 400, body: { error: 'Could not determine worktree path for this terminal' } }
    }

    const worktrees = await resolveWorktrees(webContents.id)
    if (worktrees.length > 0 && !worktrees.some((w) => w.path === worktreePath)) {
      return {
        status: 400,
        body: {
          error: `worktreePath is not a worktree of this repo: ${worktreePath}`,
          worktrees: worktrees.map((w) => w.path),
        },
      }
    }

    // Optional agent-supplied panel id: distinct ids coexist as separate tabs,
    // absent keeps the historic one-panel-per-session replace-in-place. It ends
    // up in a tab id, so keep it to characters that stay legible there.
    const panelIdArg = args['panelId']
    let panelId: string | undefined
    if (panelIdArg !== undefined && panelIdArg !== null) {
      if (typeof panelIdArg !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(panelIdArg)) {
        return {
          status: 400,
          body: { error: 'panelId must be 1–64 characters from [A-Za-z0-9_.:-]' },
        }
      }
      panelId = panelIdArg
    }

    const validation = validateSpec(args['spec'])
    if (!validation.ok) {
      return {
        status: 400,
        body: {
          error: 'spec validation failed',
          issues: validation.issues,
        },
      }
    }

    const actionIssues = await validateSpecActions(
      validation.spec,
      worktreePath,
      worktrees.map((w) => w.path),
    )
    if (actionIssues.length > 0) {
      return {
        status: 400,
        body: {
          error: 'spec actions reference content this panel cannot reach',
          issues: actionIssues,
        },
      }
    }

    if (!webContents.isDestroyed()) {
      webContents.send('agent-panel:open', {
        spec: validation.spec,
        title,
        worktreePath,
        sourceTerminalId: terminalId,
        ...(panelId ? { panelId } : {}),
      })
    } else {
      console.warn(`[MCP Bridge] webContents is destroyed, cannot send agent-panel:open IPC`)
    }

    return { status: 200, body: { ok: true } }
  }

  if (tool === 'open_worktree') {
    const requestedPath = typeof args['worktreePath'] === 'string' ? (args['worktreePath'] as string) : undefined
    const requestedBranch = typeof args['branch'] === 'string' ? (args['branch'] as string) : undefined
    if (!requestedPath && !requestedBranch) {
      return { status: 400, body: { error: 'open_worktree requires worktreePath or branch in args' } }
    }

    const worktrees = await resolveWorktrees(webContents.id)
    const match = worktrees.find(
      (w) => (requestedPath && w.path === requestedPath) || (requestedBranch && w.branch === requestedBranch),
    )
    if (!match) {
      return {
        status: 400,
        body: {
          error: `No worktree matches ${requestedPath ?? requestedBranch}`,
          worktrees: worktrees.map((w) => ({ path: w.path, branch: w.branch })),
        },
      }
    }

    if (!webContents.isDestroyed()) {
      webContents.send('agent-workspace:open-worktree', {
        sourceTerminalId: terminalId,
        worktreePath: match.path,
      })
    }
    return { status: 200, body: { ok: true, worktreePath: match.path } }
  }

  if (tool === 'show_diff') {
    const commitArg = args['commitHash']
    // Convention: null = staging (default), 'branch' = branch-base diff,
    // otherwise a commit SHA. 'staging' and '' both map to null.
    let commitHash: string | null
    if (commitArg == null || commitArg === '' || commitArg === 'staging') {
      commitHash = null
    } else if (typeof commitArg === 'string') {
      commitHash = commitArg
    } else {
      return { status: 400, body: { error: 'show_diff commitHash must be a string' } }
    }

    const agentWorktreePath = typeof args['worktreePath'] === 'string' ? (args['worktreePath'] as string) : undefined
    const worktreePath = agentWorktreePath ?? getWorktreeForTerminal(terminalId)
    if (!worktreePath) {
      return { status: 400, body: { error: 'Could not determine worktree path for this terminal' } }
    }

    // Validate the worktree belongs to the repo (defense in depth; mirrors the
    // worktree-scoping checks on show_panel). Skip when no resolver is wired.
    const worktrees = await resolveWorktrees(webContents.id)
    if (worktrees.length > 0 && !worktrees.some((w) => w.path === worktreePath)) {
      return {
        status: 400,
        body: {
          error: `worktreePath is not a worktree of this repo: ${worktreePath}`,
          worktrees: worktrees.map((w) => w.path),
        },
      }
    }

    if (!webContents.isDestroyed()) {
      webContents.send('agent-workspace:show-diff', {
        sourceTerminalId: terminalId,
        worktreePath,
        commitHash,
      })
    }
    return { status: 200, body: { ok: true } }
  }

  if (tool === 'spawn_session') {
    const brief = typeof args['brief'] === 'string' ? (args['brief'] as string).trim() : ''
    if (!brief) {
      return { status: 400, body: { error: 'spawn_session requires a non-empty brief in args' } }
    }
    const label = typeof args['label'] === 'string' ? (args['label'] as string) : undefined
    const model = typeof args['model'] === 'string' ? (args['model'] as string) : undefined
    const providerArg = args['provider']
    if (providerArg !== undefined && providerArg !== 'claude' && providerArg !== 'codex') {
      return { status: 400, body: { error: 'spawn_session provider must be claude or codex' } }
    }
    const provider = providerArg as 'claude' | 'codex' | undefined
    const reasoningEffort = typeof args['reasoningEffort'] === 'string' ? args['reasoningEffort'] : undefined
    if (model && !/^[A-Za-z0-9._:/-]+$/.test(model)) {
      return { status: 400, body: { error: 'spawn_session model has invalid syntax' } }
    }
    if (reasoningEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)) {
      return { status: 400, body: { error: 'spawn_session reasoningEffort is unsupported' } }
    }
    if (reasoningEffort && provider === 'claude') {
      return { status: 400, body: { error: 'spawn_session reasoningEffort is only compatible with Codex' } }
    }
    // Default 'new-pane'; only 'replace' is the other accepted value.
    const target = args['target'] === 'replace' ? 'replace' : 'new-pane'

    // The worktree is optional (renderer defaults to the caller's workspace).
    // When the agent names one, validate it against the repo like show_diff so
    // a typo gets actionable feedback instead of a silent wrong-target spawn.
    let worktreePath: string | undefined
    if (typeof args['worktree'] === 'string' && args['worktree']) {
      const requested = args['worktree'] as string
      const worktrees = await resolveWorktrees(webContents.id)
      if (worktrees.length > 0 && !worktrees.some((w) => w.path === requested)) {
        return {
          status: 400,
          body: {
            error: `No worktree matches ${requested}`,
            worktrees: worktrees.map((w) => w.path),
          },
        }
      }
      worktreePath = requested
    }

    if (webContents.isDestroyed()) {
      return { status: 400, body: { error: 'Window is gone; cannot spawn a session' } }
    }

    // The renderer mints the terminal id, so the handle can only come back from
    // it. Correlate the request so the caller can address what it just spawned.
    const correlationId = randomUUID()
    webContents.send('agent-session:spawn', {
      sourceTerminalId: terminalId,
      brief,
      correlationId,
      ...(label ? { label } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      target,
    })

    // 'replace' disposes the caller, so there is nobody left to use a handle —
    // waiting would only delay this session's own teardown.
    if (target === 'replace') return { status: 200, body: { ok: true } }

    const peer = await awaitSpawn(correlationId, SPAWN_HANDLE_WAIT_MS)
    if (!peer) {
      return {
        status: 200,
        body: { ok: true, note: 'New session started in SimpleEdit, but its session_id did not come back in time. Use list_sessions to find it before messaging it.' },
      }
    }
    return { status: 200, body: { ok: true, session_id: peer.terminalId, label: peer.label } }
  }

  if (tool === 'list_sessions') {
    return {
      status: 200,
      body: {
        ok: true,
        sessions: listPeers(terminalId).map((p) => ({
          session_id: p.terminalId,
          label: p.label,
          provider: p.provider ?? 'unknown',
          worktree: p.worktreePath,
          status: p.status,
          unread: p.unread,
        })),
      },
    }
  }

  if (tool === 'send_message') {
    const to = typeof args['to'] === 'string' ? args['to'] : ''
    const text = typeof args['text'] === 'string' ? args['text'] : ''
    if (!to) return { status: 400, body: { error: 'send_message requires `to`' } }

    const result = enqueue({ from: terminalId, to, text, expectsReply: args['wait_for_reply'] === true })
    if ('error' in result) return { status: 400, body: { error: result.error } }
    const { message } = result

    notifyMessage(webContents, message)

    if (!message.expectsReply) {
      return { status: 200, body: { ok: true, message_id: message.id, delivered_to: message.to } }
    }

    const requested = typeof args['timeout_seconds'] === 'number' ? args['timeout_seconds'] : DEFAULT_REPLY_WAIT_S
    const waitMs = Math.min(Math.max(requested, 10), MAX_REPLY_WAIT_S) * 1000
    const reply = await waitForReply(message.id, waitMs)
    if (!reply) {
      return {
        status: 200,
        body: {
          ok: true,
          message_id: message.id,
          delivered_to: message.to,
          timed_out: true,
          note: 'No reply yet. It will arrive as a message on your next turn — do not resend.',
        },
      }
    }
    return {
      status: 200,
      body: { ok: true, message_id: message.id, delivered_to: message.to, reply: { from: reply.from, from_label: reply.fromLabel, text: reply.text } },
    }
  }

  if (tool === 'reply') {
    const toMessageId = typeof args['to_message_id'] === 'string' ? args['to_message_id'] : ''
    const text = typeof args['text'] === 'string' ? args['text'] : ''
    if (!toMessageId) return { status: 400, body: { error: 'reply requires `to_message_id`' } }

    const origin = senderOf(toMessageId)
    if (!origin) {
      return { status: 400, body: { error: `Unknown message id "${toMessageId}". Use the id from the message you are answering.` } }
    }

    const result = enqueue({ from: terminalId, to: origin, text, replyTo: toMessageId })
    if ('error' in result) return { status: 400, body: { error: result.error } }
    notifyMessage(webContents, result.message)
    return { status: 200, body: { ok: true, message_id: result.message.id, delivered_to: result.message.to } }
  }

  if (tool === 'check_inbox') {
    const messages = drain(terminalId)
    return {
      status: 200,
      body: {
        ok: true,
        count: messages.length,
        messages: messages.map((m) => ({
          message_id: m.id,
          from: m.from,
          from_label: m.fromLabel,
          text: m.text,
          expects_reply: m.expectsReply,
        })),
      },
    }
  }

  return { status: 400, body: { error: `Unknown tool: ${tool}` } }
}

/**
 * Resolve a path to the worktree (and bare repo) that contains it. First
 * matches against the window's known worktrees; on a miss the agent has roamed
 * into a repo this window never opened, so we resolve + register it via the
 * discoverer and re-match against its worktrees. `repoPath` is non-null only on
 * that discovery path (the caller already knows the primary repo).
 */
async function locateWorktree(
  webContentsId: number,
  location: string,
  knownWorktrees: WorktreeInfo[],
): Promise<{ worktreePath: string | null; repoPath: string | null }> {
  let worktreePath = matchWorktree(location, knownWorktrees)
  if (worktreePath) return { worktreePath, repoPath: null }

  const discovered = await discoverRepo(webContentsId, location)
  if (!discovered) return { worktreePath: null, repoPath: null }
  return {
    worktreePath: matchWorktree(location, discovered.worktrees),
    repoPath: discovered.repoPath,
  }
}

/**
 * Handle a hook POST: parse session_id + cwd, route to the owning terminal,
 * and tell the renderer which worktree (if any) the cwd now sits in. Always
 * resolves 200 — hooks must never block Claude even if we can't route them.
 *
 * Two signals feed the session's repo trail:
 *   • `cwd` — where the agent IS. Drives `session:cwd`, which both records the
 *     touch and (when the viewer is closed) repoints the workspace view.
 *   • the touched `file_path` — a file the agent read/edited, which may live in
 *     a DIFFERENT repo the cwd never entered (the agent doesn't `cd` to read a
 *     file). Drives `session:repo-touch`, which records the touch ONLY: a glance
 *     at a sibling repo should surface it in the picker, not yank the view.
 *
 * Cost note: the hook response is awaited before we 200, so a miss on either
 * path briefly blocks the CLI on git subprocesses (rev-parse + worktree list),
 * paid once per new repo per window. A pathological path (network FS, huge
 * repo) would stall the CLI's hook here.
 */
async function handleHook(body: string, webContents: WebContents): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {}
  }
  const signal = parseHookBody(parsed)
  if (!signal) return {}
  return applyAgentSignal(signal, webContents)
}

/**
 * Everything a lifecycle signal drives, independent of how it arrived.
 *
 * Claude and Codex POST hooks here; OpenCode has no hooks and instead has its
 * events translated into the same `HookSignal` by its provider's control
 * channel (`agents/opencode.ts`). Keeping one implementation is what makes the
 * touched-repo trail and agent-to-agent messaging work identically for a
 * provider that never calls in — the alternative was a second, parallel
 * pathway that would drift.
 *
 * The returned record is the hook's response body, which for `Stop` may carry
 * queued peer mail. A caller that is not answering an actual HTTP hook (an
 * attached provider) must deliver that itself — see `deliverMessage`.
 */
export async function applyAgentSignal(
  signal: HookSignal,
  webContents: WebContents,
  opts: { ownsIdentityAndStatus?: boolean; deliver?: (text: string) => Promise<boolean> } = {},
): Promise<Record<string, unknown>> {
  // Codex's reporter stamps the terminal id straight into the body; Claude's
  // HTTP hooks don't, so those route by session_id through the registry.
  const terminalId = signal.terminalId ?? terminalForSession(signal.sessionId)
  if (!terminalId) return {}

  const worktrees = await resolveWorktrees(webContents.id)
  const cwd = await locateWorktree(webContents.id, signal.cwd, worktrees)
  // Deriving identity and status from a hook's event name is Codex-specific,
  // and gating it on "a terminal id is present" swept in every attached
  // provider too — which reports both itself, precisely and synchronously.
  // Letting this also run gave OpenCode a stuck status (the two awaits above
  // let a Stop-derived 'idle' land before a PostToolUse-derived 'running') and
  // published a fabricated session id. The caller says who owns these.
  if (signal.terminalId && !opts.ownsIdentityAndStatus) {
    registerCodexIdentityAndStatus(signal, terminalId, cwd.worktreePath ?? signal.cwd, webContents)
  }

  if (!webContents.isDestroyed()) {
    webContents.send('session:cwd', {
      terminalId,
      cwd: signal.cwd,
      worktreePath: cwd.worktreePath,
      repoPath: cwd.repoPath,
    })
  }

  // A touched file outside the cwd's worktree means the agent worked in another
  // worktree/repo without moving its cwd there — record it on the trail too.
  if (signal.filePath) {
    const file = await locateWorktree(webContents.id, dirname(signal.filePath), worktrees)
    if (file.worktreePath && file.worktreePath !== cwd.worktreePath && !webContents.isDestroyed()) {
      webContents.send('session:repo-touch', {
        terminalId,
        worktreePath: file.worktreePath,
        repoPath: file.repoPath,
      })
    }
  }

  return handleTurnEnd(signal, terminalId, webContents, opts.deliver)
}

/**
 * `Stop`/`SubagentStop` is both halves of the messaging channel:
 *
 *  - the turn's final assistant text is the implicit REPLY to whatever we
 *    delivered last, so a peer answers without needing to call any tool;
 *  - and if mail is queued, answering `{decision:'block'}` DELIVERS it, because
 *    both CLIs continue the turn with `reason` as input.
 *
 * Never block when `stop_hook_active` is set: that stop already belongs to a
 * turn a hook continued, and blocking again prevents the agent ever going idle.
 */
async function handleTurnEnd(
  signal: { eventName: string | null; lastAssistantMessage: string | null; stopHookActive: boolean },
  terminalId: string,
  webContents: WebContents,
  deliver?: (text: string) => Promise<boolean>,
): Promise<Record<string, unknown>> {
  if (signal.eventName !== 'Stop' && signal.eventName !== 'SubagentStop') return {}

  if (signal.lastAssistantMessage) {
    for (const reply of captureImplicitReplies(terminalId, signal.lastAssistantMessage)) {
      notifyMessage(webContents, reply)
    }
  }

  if (signal.stopHookActive || pendingCount(terminalId) === 0) return {}

  // A hook-driven provider receives mail as this function's return value, so
  // returning it IS delivery. A pushed provider can still fail after we let go
  // of the message, so its mail is peeked, pushed, and only then committed —
  // draining first would destroy the message on a failed POST while the UI
  // reported it delivered, and would park the sender on a reply never coming.
  if (deliver) {
    const pending = peekPending(terminalId)
    if (pending.length === 0) return {}
    if (!(await deliver(formatForDelivery(pending)))) return {}
  }

  const messages = drain(terminalId)
  if (messages.length === 0) return {}

  if (!webContents.isDestroyed()) {
    webContents.send('agent-message:delivered', {
      terminalId,
      messageIds: messages.map((m) => m.id),
    })
  }
  return { decision: 'block', reason: formatForDelivery(messages) }
}

function registerCodexIdentityAndStatus(
  signal: import('./cwd-tracker').HookSignal,
  terminalId: string,
  worktreePath: string,
  webContents: WebContents,
): void {
  if (webContents.isDestroyed()) return
  webContents.send('agent:session-id', { terminalId, sessionId: signal.sessionId })
  const statusByEvent: Record<string, 'initializing' | 'running' | 'waiting' | 'idle' | 'exited'> = {
    SessionStart: 'initializing',
    UserPromptSubmit: 'running',
    PermissionRequest: 'waiting',
    PostToolUse: 'running',
    Stop: 'idle',
    SessionEnd: 'exited',
  }
  const status = signal.eventName ? statusByEvent[signal.eventName] : undefined
  if (status) {
    webContents.send('agent:status', {
      worktreePath,
      status,
      terminalId,
      precise: true,
    })
  }
}

function createBridgeServer(token: string, webContents: WebContents): Server {
  return createServer(async (req, res) => {
    // Validate token from URL path: /<token>/tool-call
    const expectedPath = `/${token}/tool-call`
    const hooksPath = `/${token}/hooks`

    // Location-tracking hook endpoint (Stage 2). Token-authed via the path,
    // same scheme as tool-call. Body = the raw hook input JSON from the CLI.
    if (req.method === 'POST' && req.url === hooksPath) {
      // The response body is a real channel back into the agent (a Stop hook
      // delivery), so it must carry handleHook's result — but a throw here must
      // still degrade to an inert 200 rather than stalling the CLI's hook.
      let hookResult: Record<string, unknown> = {}
      try {
        const body = await readBody(req)
        hookResult = await handleHook(body, webContents)
      } catch {
        hookResult = {}
      }
      jsonResponse(res, 200, hookResult)
      return
    }

    if (req.method === 'POST' && req.url === expectedPath) {
      try {
        const body = await readBody(req)
        const payload = JSON.parse(body) as ToolCallPayload

        if (!payload.tool || typeof payload.tool !== 'string') {
          jsonResponse(res, 400, { error: 'Missing or invalid "tool" field' })
          return
        }
        if (!payload.terminalId || typeof payload.terminalId !== 'string') {
          jsonResponse(res, 400, { error: 'Missing or invalid "terminalId" field' })
          return
        }

        const result = await handleToolCall(payload, webContents)
        jsonResponse(res, result.status, result.body)
      } catch {
        jsonResponse(res, 400, { error: 'Invalid JSON body' })
      }
      return
    }

    jsonResponse(res, 404, { error: 'Not found' })
  })
}

export function startBridge(webContentsId: number, webContents: WebContents): Promise<number> {
  const existing = bridges.get(webContentsId)
  if (existing) {
    return Promise.resolve(existing.port)
  }

  const token = randomBytes(16).toString('hex')
  const server = createBridgeServer(token, webContents)

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Failed to get server address'))
        return
      }

      const port = addr.port
      bridges.set(webContentsId, { server, port, token, webContents })
      console.log(`[MCP Bridge] Started for webContents ${webContentsId} on 127.0.0.1:${port}`)
      resolve(port)
    })

    server.on('error', (err) => {
      reject(err)
    })
  })
}

export function stopBridge(webContentsId: number): void {
  const bridge = bridges.get(webContentsId)
  if (bridge) {
    bridge.server.close()
    bridges.delete(webContentsId)
    console.log(`[MCP Bridge] Stopped for webContents ${webContentsId}`)
  }
}

export function stopAllBridges(): void {
  for (const [id, bridge] of bridges) {
    bridge.server.close()
    bridges.delete(id)
  }
}

export function getBridgeInfo(webContentsId: number): { port: number; token: string } | null {
  const bridge = bridges.get(webContentsId)
  if (!bridge) return null
  return { port: bridge.port, token: bridge.token }
}
