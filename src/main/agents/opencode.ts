/**
 * The OpenCode agent provider.
 *
 * OpenCode integrates the opposite way round to Claude and Codex. Those two
 * report their lifecycle by calling *into* SimpleEdit over HTTP hooks, so a
 * launch is "spawn the binary, point its hooks at the bridge, wait". OpenCode
 * has no hook system at all — instead its TUI embeds the full opencode HTTP
 * server and serves it on whatever `--port` we launch it with. So SimpleEdit
 * launches it on a port it chose, then dials *out* and subscribes to `/event`.
 *
 * That single difference is worth the asymmetry: the event stream carries turn
 * boundaries, tool calls and session identity directly, so status is precise
 * and tracking is full with no one-time trust grant of the kind Codex needs.
 *
 * Verified against opencode 1.17.13.
 */
import { app } from 'electron'
import { createServer } from 'net'
import { join } from 'path'
import type { ReasoningEffort } from '../../shared/ipc-types'
import { registerSession, unregisterTerminal, type HookSignal } from '../cwd-tracker'
import {
  registerProvider,
  type AgentAttachSink,
  type AgentProvider,
  type LaunchContext,
  type LaunchPlan,
} from './provider'

/** Where an attached session's server lives, so out-of-band delivery can reach it. */
const controlPorts = new Map<string, number>()

function mcpServerPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'mcp-server', 'index.mjs')
    : join(app.getAppPath(), 'out', 'mcp-server', 'index.mjs')
}

/**
 * Ask the OS for a free TCP port and immediately give it back.
 *
 * There is an unavoidable race — the port could be taken between close and
 * OpenCode binding it — but no alternative exists: OpenCode's `--port 0` picks
 * a port itself and, in TUI mode, never prints it anywhere machine-readable,
 * and it writes no lock or registry file we could read it back from (checked
 * `~/.local/state/opencode`, which holds only locks/, model.json and prompt
 * history). Losing the race costs a failed launch, not corruption.
 */
export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a port for the OpenCode server'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

/**
 * OpenCode model ids are always `<provider>/<model>` — that is the only form
 * `--model` accepts. Everything reaching a login-shell `-c` string is injection
 * surface, so validate rather than trust.
 */
function validModelId(value: string): string {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`Invalid OpenCode model id: ${value}`)
  }
  return value
}

/** Session ids are opaque `ses_…` handles minted by the server. */
function validSessionId(value: string): string {
  if (!/^ses_[A-Za-z0-9]+$/.test(value)) {
    throw new Error(`Invalid OpenCode session id: ${value}`)
  }
  return value
}

function validVariant(value: ReasoningEffort): string {
  if (!/^[a-z]+$/.test(value)) throw new Error(`Invalid OpenCode variant: ${value}`)
  return value
}

/**
 * The bridge wiring, as an inline config OpenCode reads from the environment.
 *
 * `OPENCODE_CONFIG_CONTENT` takes the whole config as a JSON string, which
 * sidesteps both traps the Codex integration hit: there is no temp file to
 * write and clean up, and — because OpenCode has no notion of trusting a hook
 * command by hash — nothing here has to stay byte-stable across launches. The
 * per-session bridge token can therefore live in the config where it belongs.
 */
function bridgeConfigEnv(ctx: LaunchContext): Record<string, string> {
  if (ctx.bridgePort == null || ctx.bridgeToken == null) return {}
  const config = {
    mcp: {
      simpleedit: {
        type: 'local',
        command: ['node', mcpServerPath()],
        enabled: true,
        environment: {
          SIMPLEEDIT_BRIDGE_PORT: String(ctx.bridgePort),
          SIMPLEEDIT_BRIDGE_TOKEN: ctx.bridgeToken,
          SIMPLEEDIT_TERMINAL_ID: ctx.terminalId,
        },
      },
    },
  }
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
}

async function buildLaunch(ctx: LaunchContext): Promise<LaunchPlan> {
  const port = await reservePort()
  const model = ctx.target?.provider === 'opencode' ? ctx.target.model : undefined
  const effort: ReasoningEffort | undefined =
    ctx.target?.provider === 'opencode' ? ctx.target.reasoningEffort : ctx.reasoningEffort

  const args = ['--port', String(port), '--hostname', '127.0.0.1']

  if (model) args.push('--model', validModelId(model))
  if (effort) args.push('--variant', validVariant(effort))

  if (ctx.resumeSessionId) {
    args.push('--session', validSessionId(ctx.resumeSessionId))
    // `--fork` is only meaningful alongside --session/--continue; OpenCode
    // rejects it on its own. Forking leaves the source session intact and
    // continues in a new one, which is the same contract as Claude's
    // `--fork-session` — but the new id is minted server-side, so unlike Claude
    // we cannot know it until the event stream reports it.
    if (ctx.forkSession) args.push('--fork')
  }

  // `--prompt`, never a positional. OpenCode's positional argument is the
  // PROJECT PATH (`opencode [project]`), so appending the prompt the way the
  // Claude provider does would make OpenCode treat a review brief as a
  // directory to open.
  if (ctx.initialPrompt) args.push('--prompt', ctx.initialPrompt)

  registerSession(ctx.terminalId, ctx.terminalId)
  controlPorts.set(ctx.terminalId, port)

  return {
    executable: 'opencode',
    args,
    env: bridgeConfigEnv(ctx),
    cleanup: () => {
      controlPorts.delete(ctx.terminalId)
      unregisterTerminal(ctx.terminalId)
    },
  }
}

/** How long to wait for the embedded server to bind before giving up. */
const HEALTH_TIMEOUT_MS = 60_000
const HEALTH_INTERVAL_MS = 250

async function waitForHealth(port: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline && !signal.aborted) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal })
      if (res.ok) return true
    } catch {
      // Not listening yet — the TUI takes a moment to bind. Keep waiting.
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS))
  }
  return false
}

/**
 * Accumulates the per-session state one `/event` frame at a time.
 *
 * OpenCode's events are narrower than a hook POST — none of them carries the
 * session id, cwd and touched file together — so a `HookSignal` has to be
 * assembled from several frames. That is what this holds.
 */
export interface EventState {
  /** Server-minted `ses_…` id, learned from the first session event. */
  sessionId?: string
  /** Text of the last completed assistant block, for the mail reply channel. */
  lastAssistantMessage?: string
  /**
   * `messageID` → role, learned from `message.updated`.
   *
   * Load-bearing: a text part carries only its `messageID`, and the USER's own
   * prompt arrives as a text part exactly like the assistant's answer. Without
   * this, the reply sent back to a waiting peer would be that peer's own
   * question echoed back at it.
   */
  roles?: Map<string, string>
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/**
 * Map one `/event` payload onto the sink.
 *
 * Names and field shapes come from a CAPTURED live turn on opencode 1.18.15,
 * cross-checked against its OpenAPI document — not from either alone, because
 * the two disagree in a way that matters: the schema also describes a
 * `session.next.*` / `file.edited` family that a default `/event` subscription
 * NEVER emits (a real turn produced only `session.status`, `session.idle`,
 * `message.updated` and `message.part.updated`). Those handlers are kept for
 * installations running the v2 stream, but the `message.part.updated` path
 * below is the one that actually carries tool calls and text today. Building
 * solely off the schema would have produced an integration that typechecked,
 * looked right, and reported nothing.
 *
 * Unrecognised events are ignored rather than guessed at, so a future event
 * can never fabricate a status.
 */
export function applyEvent(
  event: unknown,
  sink: AgentAttachSink,
  state: EventState,
  ctx: { terminalId: string; cwd: string },
): void {
  const frame = record(event)
  const type = str(frame?.['type'])
  if (!frame || !type) return
  const props = record(frame['properties']) ?? {}

  /**
   * Assemble the hook-shaped signal from what this frame carries plus what
   * earlier frames established. `terminalId` is always known (we launched the
   * process), so unlike Claude this never needs session→terminal registry
   * routing — which is why a session id we have not learned yet is not fatal.
   */
  const emit = (extra: Partial<HookSignal> & { eventName: string }): void => {
    sink.signal({
      sessionId: state.sessionId ?? ctx.terminalId,
      terminalId: ctx.terminalId,
      cwd: ctx.cwd,
      filePath: null,
      lastAssistantMessage: null,
      stopHookActive: false,
      ...extra,
    })
  }

  switch (type) {
    case 'session.created':
    case 'session.updated': {
      const id = str(props['sessionID']) ?? str(record(props['info'])?.['id'])
      if (id) state.sessionId = id
      return
    }

    // The authoritative status signal: `{ status: { type: 'idle'|'busy'|'retry' } }`.
    // `retry` is a transient provider failure the agent recovers from on its
    // own, so it stays 'running' with the reason surfaced — reporting 'error'
    // would make a self-healing hiccup look like a dead session.
    case 'session.status': {
      const status = record(props['status'])
      switch (str(status?.['type'])) {
        case 'idle':
          sink.status('idle')
          return
        case 'busy':
          sink.status('running')
          return
        case 'retry':
          sink.status('running', str(status?.['message']))
          return
        default:
          return
      }
    }

    // Turn boundary — reported as a `Stop`, which is exactly what it is. That
    // one name is what routes OpenCode into the existing agent-messaging
    // channel: queued mail is delivered here, and `lastAssistantMessage` is
    // the reply to whoever was waiting on this session's answer.
    //
    // `stopHookActive` is always false because it cannot be otherwise: it
    // guards Claude's re-entrant Stop hook (a stop belonging to a turn a hook
    // already continued), and OpenCode has no hook to re-enter. Mail is pushed
    // as a fresh prompt, which produces an ordinary new turn.
    case 'session.idle':
      sink.status('idle')
      emit({
        eventName: 'Stop',
        ...(state.lastAssistantMessage ? { lastAssistantMessage: state.lastAssistantMessage } : {}),
      })
      state.lastAssistantMessage = undefined
      return

    case 'session.error': {
      const error = record(props['error'])
      sink.status('error', str(record(error?.['data'])?.['message']) ?? str(error?.['name']))
      return
    }

    // A permission prompt is on screen and the agent cannot progress until the
    // user answers, which is what 'waiting' means for every other provider.
    case 'permission.asked':
    case 'permission.v2.asked':
      sink.status('waiting')
      return

    case 'permission.replied':
    case 'permission.v2.replied':
      sink.status('running')
      return

    case 'session.next.step.started':
      sink.status('running')
      return

    // A file OpenCode actually wrote. Dedicated event, so no digging through
    // tool payloads is needed for the edit half of the touched-repo trail.
    case 'file.edited': {
      const file = str(props['file'])
      if (file) emit({ eventName: 'PostToolUse', filePath: file })
      return
    }

    // The read half: a tool call naming a file. Reads never move the cwd, so
    // without this a glance into a sibling repo would never reach the repo
    // picker — the exact bug `session-repo-trail` guards for Claude.
    //
    // `filePath` ONLY. OpenCode's grep/glob/list tools put a DIRECTORY in
    // `path`, and the consumer takes `dirname` of whatever it gets, so a
    // directory resolves a level too high — typically the project root, outside
    // every worktree (see `parseToolFilePath`'s note on the same trap).
    case 'session.next.tool.called': {
      const file = str(record(props['input'])?.['filePath'])
      if (file) emit({ eventName: 'PostToolUse', filePath: file })
      return
    }

    // The complete text of an assistant block — OpenCode's equivalent of the
    // `last_assistant_message` that Claude's Stop hook reports.
    case 'session.next.text.ended': {
      const text = str(props['text'])
      if (text) state.lastAssistantMessage = text
      return
    }

    // Roles live here and nowhere else; parts reference their message by id.
    case 'message.updated': {
      const info = record(props['info'])
      const id = str(info?.['id'])
      const role = str(info?.['role'])
      if (id && role) (state.roles ??= new Map()).set(id, role)
      return
    }

    // The live vocabulary. Both tool calls and assistant text arrive as parts
    // of a message rather than as dedicated events.
    case 'message.part.updated': {
      const part = record(props['part'])
      if (!part) return

      if (part['type'] === 'tool') {
        const toolState = record(part['state'])
        // A tool part is republished on every state transition
        // (pending → running → completed|error), and only the terminal state
        // means the file was really read or written. Acting earlier would
        // report the same touch three times and would record a read that
        // failed — a file-not-found is not a touched repo.
        if (str(toolState?.['status']) !== 'completed') return
        // `filePath` only. grep/glob/list carry a `pattern` or a DIRECTORY in
        // `path`, and the consumer takes dirname() of whatever it gets, so a
        // directory resolves a level too high — typically the project root,
        // outside every worktree (see `parseToolFilePath`'s note on the trap).
        const file = str(record(toolState?.['input'])?.['filePath'])
        if (file) emit({ eventName: 'PostToolUse', filePath: file })
        return
      }

      if (part['type'] === 'text') {
        // Assistant text only — the user's own prompt is published as a text
        // part too, and relaying that back would answer a peer with its own
        // question.
        const messageId = str(part['messageID'])
        if (!messageId || state.roles?.get(messageId) !== 'assistant') return
        const text = str(part['text'])
        if (text) state.lastAssistantMessage = text
      }
      return
    }

    default:
      return
  }
}

/**
 * Read the SSE body line by line, feeding each `data:` payload to `applyEvent`.
 * Kept separate from the transport so it can be tested against captured frames.
 */
export async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  sink: AgentAttachSink,
  ctx: { terminalId: string; cwd: string },
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const state: EventState = {}
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      try {
        applyEvent(JSON.parse(line.slice('data:'.length).trim()), sink, state, ctx)
      } catch {
        // A malformed frame must not tear down the subscription.
      }
    }
  }
}

function attach(_plan: LaunchPlan, ctx: LaunchContext, sink: AgentAttachSink): () => void {
  const port = controlPorts.get(ctx.terminalId)
  const controller = new AbortController()
  if (port == null) return () => controller.abort()

  void (async () => {
    if (!(await waitForHealth(port, controller.signal))) {
      if (!controller.signal.aborted) {
        sink.status('error', 'OpenCode server did not start')
      }
      return
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/event`, { signal: controller.signal })
      if (res.body) {
        await consumeEventStream(res.body, sink, { terminalId: ctx.terminalId, cwd: ctx.worktreePath })
      }
    } catch {
      // Aborted on exit, or the server went away with the process. Either way
      // the PTY exit path owns reporting the session's end.
    }
  })()

  return () => controller.abort()
}

/**
 * Deliver peer mail into a live OpenCode session.
 *
 * Claude and Codex receive mail as the response body of their `Stop` hook.
 * OpenCode has no such hook, so delivery is a push instead: `prompt_async`
 * queues the text as a fresh user turn. This still writes no PTY bytes and
 * still only fires at a turn boundary (the caller sends on `session.idle`), so
 * the "never race the live TUI" invariant holds — only the mechanism differs.
 */
async function deliverMessage(terminalId: string, text: string): Promise<boolean> {
  const port = controlPorts.get(terminalId)
  if (port == null) return false
  try {
    const sessions = await fetch(`http://127.0.0.1:${port}/session`)
    if (!sessions.ok) return false
    const list: unknown = await sessions.json()
    const first = Array.isArray(list) ? list[0] : undefined
    const sessionId = first && typeof first === 'object' ? (first as Record<string, unknown>)['id'] : undefined
    if (typeof sessionId !== 'string') return false
    const res = await fetch(`http://127.0.0.1:${port}/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    })
    return res.ok
  } catch {
    return false
  }
}

export const opencodeProvider: AgentProvider = {
  id: 'opencode',
  buildLaunch,
  attach,
  deliverMessage,
  capabilities: {
    // Precise, and without Codex's one-time trust grant: the status comes from
    // the server OpenCode itself is hosting, not from a hook it must be
    // persuaded to run.
    status: 'precise',
    resume: true,
    fork: true,
    tracking: 'full',
    mcp: true,
    modelOverride: 'native',
    shiftEnter: 'native',
    droppedPath: 'at-reference',
    gracefulShutdown: true,
    displayName: 'OpenCode',
    // OpenCode's OSC title is the literal constant "OpenCode" — not a
    // conversation name and not the directory. Letting it through would rename
    // every OpenCode session to "OpenCode".
    oscTitle: 'constant',
    reportingSetup: 'automatic',
    modelSelector: 'model-id',
    nativeModelBrand: 'opencode',
    reasoningEffort: true,
    modelCatalog: true,
  },
}

registerProvider(opencodeProvider)
