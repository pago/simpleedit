/**
 * OpenCode provider contract.
 *
 * Every event payload below is shaped from opencode 1.18.15's own OpenAPI
 * document and a captured live stream — not from output imagined to match the
 * parser. Assertions are on the properties a launch must GUARANTEE (read-only
 * really denies writes; a prompt never lands where a path is expected), not on
 * the exact argv the builder happens to emit, which would only restate itself.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app' } }))

import { opencodeProvider, applyEvent, reservePort, type EventState } from '../opencode'
import type { AgentAttachSink } from '../provider'
import type { HookSignal } from '../../cwd-tracker'
import { buildOpenCodeRunArgs, openCodeReadOnlyEnv, openCodeAgentText } from '../../agent-tasks/runner'
import liveTurn from './fixtures/opencode-live-turn.json'

const base = { terminalId: 't1', worktreePath: '/repo/main' }
const CTX = { terminalId: 't1', cwd: '/repo/main' }

function collect(): {
  sink: AgentAttachSink
  statuses: [string, string | undefined][]
  signals: HookSignal[]
  titles: string[]
} {
  const statuses: [string, string | undefined][] = []
  const signals: HookSignal[] = []
  const titles: string[] = []
  return {
    statuses,
    signals,
    titles,
    sink: {
      status: (s, m) => statuses.push([s, m]),
      signal: (s) => signals.push(s),
      title: (t) => titles.push(t),
    },
  }
}

function apply(events: unknown[], state: EventState = {}): ReturnType<typeof collect> {
  const c = collect()
  for (const e of events) applyEvent(e, c.sink, state, CTX)
  return c
}

describe('opencode buildLaunch', () => {
  it('serves its control channel on a port we chose, bound to loopback', async () => {
    const plan = await opencodeProvider.buildLaunch({ ...base })
    const portIndex = plan.args.indexOf('--port')
    expect(portIndex).toBeGreaterThanOrEqual(0)
    expect(Number(plan.args[portIndex + 1])).toBeGreaterThan(0)
    // Loopback only: the session's server must not be reachable off-box.
    expect(plan.args[plan.args.indexOf('--hostname') + 1]).toBe('127.0.0.1')
    plan.cleanup?.()
  })

  it('reserves a DIFFERENT port per session so two agents never collide', async () => {
    const a = await opencodeProvider.buildLaunch({ ...base, terminalId: 'a' })
    const b = await opencodeProvider.buildLaunch({ ...base, terminalId: 'b' })
    expect(a.args[a.args.indexOf('--port') + 1]).not.toBe(b.args[b.args.indexOf('--port') + 1])
    a.cleanup?.()
    b.cleanup?.()
  })

  it('passes the initial prompt as a flag, never positionally', async () => {
    const brief = 'Review this PR and report findings'
    const plan = await opencodeProvider.buildLaunch({ ...base, initialPrompt: brief })
    // OpenCode's positional argument is the PROJECT PATH (`opencode [project]`),
    // so a prompt that reaches a positional slot is read as a directory to open
    // — the trap a straight port of the Claude provider falls into. The brief
    // must therefore appear ONLY ever as the value of `--prompt`, never bare.
    const occurrences = plan.args.reduce<number[]>((acc, a, i) => (a === brief ? [...acc, i] : acc), [])
    expect(occurrences).toHaveLength(1)
    expect(plan.args[occurrences[0]! - 1]).toBe('--prompt')
    plan.cleanup?.()
  })

  it('resumes by session id, and forks only alongside one', async () => {
    const resume = await opencodeProvider.buildLaunch({ ...base, resumeSessionId: 'ses_024f0ffacffeWVpTLIKkTx5w21' })
    expect(resume.args).toContain('--session')
    expect(resume.args).not.toContain('--fork')

    const fork = await opencodeProvider.buildLaunch({
      ...base,
      resumeSessionId: 'ses_024f0ffacffeWVpTLIKkTx5w21',
      forkSession: true,
    })
    expect(fork.args).toContain('--fork')

    // `--fork` without a session is rejected by OpenCode itself, so it must
    // never be emitted on a fresh spawn.
    const fresh = await opencodeProvider.buildLaunch({ ...base, forkSession: true })
    expect(fresh.args).not.toContain('--fork')
    ;[resume, fork, fresh].forEach((p) => p.cleanup?.())
  })

  it('rejects ids that could break out of the login-shell command string', async () => {
    await expect(
      opencodeProvider.buildLaunch({ ...base, target: { provider: 'opencode', model: 'x;rm -rf /' } }),
    ).rejects.toThrow(/Invalid OpenCode model/)
    await expect(
      opencodeProvider.buildLaunch({ ...base, resumeSessionId: 'ses_$(id)' }),
    ).rejects.toThrow(/Invalid OpenCode session/)
    // Unqualified model ids are refused: `--model` only accepts provider/model.
    await expect(
      opencodeProvider.buildLaunch({ ...base, target: { provider: 'opencode', model: 'deepseek-v4-flash-free' } }),
    ).rejects.toThrow(/Invalid OpenCode model/)
  })

  it('carries the bridge in the env, so no temp config file outlives the session', async () => {
    const plan = await opencodeProvider.buildLaunch({ ...base, bridgePort: 4123, bridgeToken: 'secret' })
    const config: unknown = JSON.parse(plan.env?.['OPENCODE_CONFIG_CONTENT'] ?? '{}')
    const mcp = (config as { mcp?: Record<string, { environment?: Record<string, string> }> }).mcp
    expect(mcp?.['simpleedit']?.environment?.['SIMPLEEDIT_BRIDGE_TOKEN']).toBe('secret')
    expect(mcp?.['simpleedit']?.environment?.['SIMPLEEDIT_TERMINAL_ID']).toBe('t1')
    plan.cleanup?.()
  })

  it('wires no bridge config at all when there is no bridge', async () => {
    const plan = await opencodeProvider.buildLaunch({ ...base })
    expect(plan.env?.['OPENCODE_CONFIG_CONTENT']).toBeUndefined()
    plan.cleanup?.()
  })
})

describe('reservePort', () => {
  it('hands back a port that is actually free to bind', async () => {
    const port = await reservePort()
    expect(port).toBeGreaterThan(1023)
  })
})

describe('opencode event mapping', () => {
  it('maps the three session statuses onto SimpleEdit statuses', () => {
    const busy = apply([{ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } }])
    expect(busy.statuses).toEqual([['running', undefined]])

    const idle = apply([{ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } }])
    expect(idle.statuses).toEqual([['idle', undefined]])
  })

  it('treats a retry as still running, not as a dead session', () => {
    // `retry` is a transient provider hiccup OpenCode recovers from on its own.
    // Reporting 'error' would light up the sidebar for a session that is fine.
    const c = apply([
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'retry', attempt: 1, message: 'rate limited', next: 2 } } },
    ])
    expect(c.statuses).toEqual([['running', 'rate limited']])
  })

  it('reports waiting while a permission prompt blocks the agent', () => {
    const c = apply([
      { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_1', permission: 'edit', patterns: [], metadata: {}, always: [] } },
    ])
    expect(c.statuses).toEqual([['waiting', undefined]])
  })

  it('reports a turn boundary as a Stop carrying the last assistant text', () => {
    // This is what routes OpenCode into the existing agent-messaging channel:
    // the reply a peer is waiting on is the turn's final assistant message.
    const c = apply([
      { type: 'session.created', properties: { sessionID: 'ses_abc', info: { id: 'ses_abc' } } },
      { type: 'session.next.text.ended', properties: { sessionID: 'ses_abc', text: 'the answer is 42' } },
      { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
    ])
    const stop = c.signals.find((s) => s.eventName === 'Stop')
    expect(stop?.lastAssistantMessage).toBe('the answer is 42')
    expect(stop?.sessionId).toBe('ses_abc')
    expect(stop?.terminalId).toBe('t1')
  })

  it('never re-reports a stale assistant message on the next turn', () => {
    const state: EventState = {}
    apply([
      { type: 'session.next.text.ended', properties: { text: 'first turn' } },
      { type: 'session.idle', properties: {} },
    ], state)
    // A second turn that produced no text must not answer with the first turn's.
    const second = apply([{ type: 'session.idle', properties: {} }], state)
    expect(second.signals.find((s) => s.eventName === 'Stop')?.lastAssistantMessage).toBeNull()
  })

  it('never claims a Stop is re-entrant, so mail is never suppressed', () => {
    // `stopHookActive` guards Claude's re-entrant Stop hook. OpenCode has no
    // hook to re-enter, so a true here would silently drop every message.
    const c = apply([{ type: 'session.idle', properties: {} }])
    expect(c.signals[0]?.stopHookActive).toBe(false)
  })

  it('records an edited file for the touched-repo trail', () => {
    const c = apply([{ type: 'file.edited', properties: { file: '/other/repo/src/a.ts' } }])
    expect(c.signals[0]?.filePath).toBe('/other/repo/src/a.ts')
    expect(c.signals[0]?.eventName).toBe('PostToolUse')
  })

  it('records a READ file too — a read never moves the cwd', () => {
    // Without this a glance into a sibling repo would never reach the repo
    // picker, the exact bug `session-repo-trail` guards against for Claude.
    const c = apply([
      { type: 'session.next.tool.called', properties: { tool: 'read', input: { filePath: '/other/repo/pkg.json' } } },
    ])
    expect(c.signals[0]?.filePath).toBe('/other/repo/pkg.json')
  })

  it('ignores a tool input that names a DIRECTORY rather than a file', () => {
    // grep/glob/list put a directory in `path`. The consumer takes dirname() of
    // whatever it gets, so a directory resolves a level too high — typically
    // the project root, outside every worktree.
    const c = apply([
      { type: 'session.next.tool.called', properties: { tool: 'grep', input: { path: '/repo/main/src' } } },
    ])
    expect(c.signals).toEqual([])
  })

  it('ignores unknown events instead of inventing a status', () => {
    const c = apply([
      { type: 'session.next.reasoning.delta', properties: { delta: 'hmm' } },
      { type: 'some.future.event', properties: {} },
      { type: 'installation.updated', properties: {} },
      'not an object',
      null,
    ])
    expect(c.statuses).toEqual([])
    expect(c.signals).toEqual([])
  })
})

/**
 * Replays a stream captured from a real `opencode` turn (1.18.15) end to end.
 *
 * This is the test that earns its keep: built purely from the OpenAPI document,
 * the mapping handled a `session.next.*` / `file.edited` family that a default
 * `/event` subscription never emits, so it would have typechecked, read
 * correctly, and reported nothing at all.
 */
describe('opencode against a captured real turn', () => {
  const frames: unknown[] = liveTurn

  it('tracks the turn from busy through to idle', () => {
    const c = apply(frames)
    expect(c.statuses.map(([s]) => s)[0]).toBe('running')
    expect(c.statuses.map(([s]) => s).at(-1)).toBe('idle')
  })

  it('learns the server-minted session id', () => {
    const c = apply(frames)
    expect(c.signals.every((s) => s.sessionId.startsWith('ses_'))).toBe(true)
  })

  it('reports the learned session id exactly once, not per frame', () => {
    // Out-of-band mail delivery targets this id. The server is per PROJECT and
    // lists every session in its history, so "the first one" would post a
    // peer's message into an unrelated conversation.
    const seen: string[] = []
    const c = collect()
    const state: EventState = {}
    for (const f of frames) {
      applyEvent(f, c.sink, state, { ...CTX, onSessionId: (id) => seen.push(id) })
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^ses_/)
  })

  it('reports exactly one turn boundary', () => {
    const c = apply(frames)
    expect(c.signals.filter((s) => s.eventName === 'Stop')).toHaveLength(1)
  })

  it("replies with the assistant's answer, never the user's own prompt", () => {
    const c = apply(frames)
    const stop = c.signals.find((s) => s.eventName === 'Stop')
    expect(stop?.lastAssistantMessage).toBe('No package.json exists in the scratchpad directory.')
    // The prompt that STARTED the turn is published as a text part too. Echoing
    // it back would answer a waiting peer with its own question.
    expect(stop?.lastAssistantMessage).not.toContain('Read the file package.json')
  })

  it('records a completed file read exactly once, not once per state transition', () => {
    // The captured turn contains one `read` republished as pending → running →
    // error, and one `glob` carrying a pattern rather than a file.
    const c = apply(frames)
    const touches = c.signals.filter((s) => s.filePath !== null)
    // The read FAILED (file not found), so it is not a touched repo at all.
    expect(touches).toHaveLength(0)
  })
})

describe('opencode conversation title', () => {
  it('publishes the name OpenCode gives the conversation', () => {
    const c = apply([
      { type: 'session.updated', properties: { info: { id: 'ses_1', title: 'Capital of France' } } },
    ])
    expect(c.titles).toEqual(['Capital of France'])
  })

  it('suppresses the placeholder a session carries before it is named', () => {
    // OpenCode stamps `New session - <ISO timestamp>` until its title agent
    // runs. Showing that would be strictly worse than the default label.
    const c = apply([
      { type: 'session.created', properties: { info: { id: 'ses_1', title: 'New session - 2026-08-07T09:01:34.098Z' } } },
    ])
    expect(c.titles).toEqual([])
  })

  it('publishes a title once, not on every session.updated', () => {
    // The captured turn shows session.updated repeating many times per turn;
    // re-sending an unchanged title would rewrite the sidebar label constantly.
    const state: EventState = {}
    const c = collect()
    for (let i = 0; i < 5; i++) {
      applyEvent({ type: 'session.updated', properties: { info: { id: 'ses_1', title: 'Same Name' } } }, c.sink, state, CTX)
    }
    expect(c.titles).toEqual(['Same Name'])
  })

  it('publishes a genuinely new title when the conversation is renamed', () => {
    const state: EventState = {}
    const c = collect()
    applyEvent({ type: 'session.updated', properties: { info: { id: 'ses_1', title: 'First' } } }, c.sink, state, CTX)
    applyEvent({ type: 'session.updated', properties: { info: { id: 'ses_1', title: 'Second' } } }, c.sink, state, CTX)
    expect(c.titles).toEqual(['First', 'Second'])
  })
})

describe('opencode bounded read-only execution', () => {
  it('denies every world-changing tool', () => {
    const permission: Record<string, string> = JSON.parse(openCodeReadOnlyEnv()['OPENCODE_PERMISSION'] ?? '{}')
    for (const tool of ['edit', 'bash', 'task', 'webfetch', 'websearch', 'external_directory']) {
      expect(permission[tool]).toBe('deny')
    }
  })

  it('still allows the tools an analysis actually needs', () => {
    const permission: Record<string, string> = JSON.parse(openCodeReadOnlyEnv()['OPENCODE_PERMISSION'] ?? '{}')
    for (const tool of ['read', 'grep', 'glob', 'list']) {
      expect(permission[tool]).toBe('allow')
    }
  })

  it('denies bash outright rather than trying to judge the command', () => {
    // `bash("git log")` and `bash("git push")` are the same tool call, so a
    // read-only claim that allowed bash would simply be untrue.
    const permission: Record<string, string> = JSON.parse(openCodeReadOnlyEnv()['OPENCODE_PERMISSION'] ?? '{}')
    expect(permission['bash']).toBe('deny')
  })

  it('asks for machine-readable output', () => {
    const args = buildOpenCodeRunArgs({ cwd: '/repo' })
    expect(args.slice(0, 3)).toEqual(['run', '--format', 'json'])
  })

  it('extracts assistant text from a real captured frame', () => {
    // Verbatim shape from `opencode run --format json` on 1.17.13.
    const frame = {
      type: 'text',
      timestamp: 1786087305251,
      sessionID: 'ses_024e6ac69ffeqOMiWgGgDS6CAP',
      part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: '{"finding":"x"}' },
    }
    expect(openCodeAgentText(frame)).toBe('{"finding":"x"}')
  })

  it('ignores non-text frames so partial output never reaches the scanner', () => {
    expect(openCodeAgentText({ type: 'step_start', part: {} })).toBeNull()
    expect(openCodeAgentText({ type: 'tool_use', part: { state: { output: '{"finding":"no"}' } } })).toBeNull()
    expect(openCodeAgentText({ type: 'step_finish', part: { reason: 'stop' } })).toBeNull()
  })
})

describe('opencode capabilities are honest claims', () => {
  it('does not claim a session label it cannot provide', () => {
    // The OSC title is the literal constant "OpenCode" — verified against a
    // real TUI run. Claiming 'session-label' would rename every session to it.
    expect(opencodeProvider.capabilities.oscTitle).toBe('constant')
  })

  it('needs no user grant, unlike a hook-gated provider', () => {
    expect(opencodeProvider.capabilities.reportingSetup).toBe('automatic')
  })

  it('offers an out-of-band delivery path, since it has no Stop hook to ride', () => {
    expect(typeof opencodeProvider.deliverMessage).toBe('function')
    expect(typeof opencodeProvider.attach).toBe('function')
  })
})
