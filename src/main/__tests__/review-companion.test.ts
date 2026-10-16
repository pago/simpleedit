import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import { claimCompanion, createReview, getReview, rebindCompanion, setReviewStatus } from '../review-room-store'
import { setReviewCacheRootForTests } from '../review-checkout'
import {
  COMPANION_CREATE_TIMEOUT_MS,
  assertUnclaimed,
  companionInfo,
  companionLaunchFor,
  companionSpawnFor,
  exitSettlesDelivery,
  defaultCompanionAgent,
  endCompanionsOfWindow,
  ensureCompanion,
  initReviewCompanion,
  markCompanionQuitting,
  noteCompanionStatus,
  onCompanionExited,
  rebindCompanionSession,
  resetReviewCompanion,
  resolveCompanionCreated,
  reviewAgentFromTarget,
  setReviewCompanionAgent,
  targetFromReviewAgent,
  type ReviewCompanionDeps,
} from '../review-companion'
import type { ReviewCompanionCreateRequest } from '../../shared/review-room-ipc'
import type { InteractiveTarget } from '../../shared/ipc-types'
import '../agents/claude'
import '../agents/codex'
import '../agents/opencode'

const layers = [
  { url: 'https://github.com/acme/app/pull/12', number: 12, headSha: 'a'.repeat(40) },
  { url: 'https://github.com/acme/app/pull/13', number: 13, headSha: 'b'.repeat(40) },
]
const REVIEW = 'r_review01'
const desktop = { id: 1 }

let root: string
let sent: Array<{ windowId: number; request: ReviewCompanionCreateRequest }>
let live: Set<string>
let deps: ReviewCompanionDeps & { requestSend: ReturnType<typeof vi.fn<(id: string) => void>>; kill: ReturnType<typeof vi.fn<(id: string) => void>> }

function answerLast(outcome: unknown): void {
  resolveCompanionCreated(desktop, sent.at(-1)!.request.correlationId, outcome)
}

/** Lets the create request go out (the brief awaits the rubric first). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  useDbForTests(openDb(':memory:'))
  root = mkdtempSync(join(tmpdir(), 'se-companion-'))
  setReviewCacheRootForTests(root)
  createReview({ id: REVIEW, repo: 'github.com/acme/app', layers, companionAgent: { provider: 'claude', model: 'default' } })
  sent = []
  live = new Set()
  deps = {
    sendCreateRequest: (windowId, request) => {
      sent.push({ windowId, request })
      return true
    },
    broadcast: vi.fn(),
    requestSend: vi.fn<(id: string) => void>(),
    isLive: (id) => live.has(id),
    kill: vi.fn<(id: string) => void>((id) => {
      live.delete(id)
    }),
    modelConfig: () => null,
    rubric: async () => '<review-rubric>be kind</review-rubric>',
  }
  initReviewCompanion(deps)
})

afterEach(() => {
  resetReviewCompanion()
  setReviewCacheRootForTests(null)
  rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('starting a companion', () => {
  it('claims once under a race, asks only the winning window, then sends what is held', async () => {
    const first = ensureCompanion(REVIEW, 1)
    const second = ensureCompanion(REVIEW, 2)
    await flush()
    expect(sent).toHaveLength(1)
    const { windowId, request } = sent[0]!
    expect(windowId).toBe(1)
    expect(request).toMatchObject({ reviewId: REVIEW, target: { provider: 'claude' } })
    expect(request.sessionId).toBe(getReview(REVIEW)!.companion!.sessionId)
    expect(request.brief).toContain('be kind')
    expect(existsSync(join(root, 'review-checkouts', REVIEW))).toBe(true)
    answerLast({ ok: true })
    live.add(request.sessionId)
    await expect(first).resolves.toBe(request.sessionId)
    await expect(second).resolves.toBe(request.sessionId)
    expect(deps.requestSend).toHaveBeenCalledWith(request.sessionId)
    // Live now: another Ask reuses it.
    await expect(ensureCompanion(REVIEW, 2)).resolves.toBe(request.sessionId)
    expect(sent).toHaveLength(1)
  })

  it('clears its own claim when the window refuses', async () => {
    const started = ensureCompanion(REVIEW, 1)
    await flush()
    answerLast({ ok: false, reason: 'no repo' })
    await expect(started).rejects.toThrow('no repo')
    expect(getReview(REVIEW)!.companion).toBeUndefined()
    expect(deps.requestSend).not.toHaveBeenCalled()
  })

  it('kills a session that launched before the window refused, and refuses its late spawn', async () => {
    const started = ensureCompanion(REVIEW, 1)
    await flush()
    const reserved = sent[0]!.request.sessionId
    live.add(reserved)
    answerLast({ ok: false, reason: 'gave up' })
    await expect(started).rejects.toThrow('gave up')
    expect(deps.kill).toHaveBeenCalledWith(reserved)
    expect(getReview(REVIEW)!.companion).toBeUndefined()
    expect(() => companionSpawnFor(reserved, { kind: 'review', reviewId: REVIEW })).toThrow('claim has ended')
  })

  it('launches a workflow worker as a normal session and refuses a malformed owner', () => {
    expect(companionSpawnFor('worker-1', { kind: 'workflow', workflowId: 'wf_abcdefgh', taskId: 'build', attempt: 1 })).toBeUndefined()
    expect(() => companionSpawnFor('worker-2', { kind: 'nobody' })).toThrow('not valid')
  })

  it('kills a session that launched before the timeout fired', async () => {
    vi.useFakeTimers()
    const started = ensureCompanion(REVIEW, 1)
    await flush()
    const reserved = sent[0]!.request.sessionId
    live.add(reserved)
    vi.advanceTimersByTime(COMPANION_CREATE_TIMEOUT_MS + 1)
    await expect(started).rejects.toThrow('in time')
    expect(deps.kill).toHaveBeenCalledWith(reserved)
    expect(getReview(REVIEW)!.companion).toBeUndefined()
  })

  it('clears its own claim on a timeout, and only that claim', async () => {
    vi.useFakeTimers()
    const started = ensureCompanion(REVIEW, 1)
    await flush()
    const reserved = sent[0]!.request.sessionId
    // The claim moved on meanwhile (a resume elsewhere): the timeout must not clear it.
    rebindCompanion(REVIEW, reserved, 'agent-claude-other', 1)
    vi.advanceTimersByTime(COMPANION_CREATE_TIMEOUT_MS + 1)
    await expect(started).rejects.toThrow('in time')
    expect(getReview(REVIEW)!.companion?.sessionId).toBe('agent-claude-other')
  })

  it('replaces a stale claim that has no live PTY', async () => {
    claimCompanion(REVIEW, 1, 'old')
    const stale = getReview(REVIEW)!.companion!.sessionId
    const started = ensureCompanion(REVIEW, 1)
    await flush()
    expect(sent[0]!.request.sessionId).not.toBe(stale)
    answerLast({ ok: true })
    await started
  })

  it('refuses a review that is not open', async () => {
    setReviewStatus(REVIEW, 'discarded')
    await expect(ensureCompanion(REVIEW, 1)).rejects.toThrow('not open')
    expect(sent).toHaveLength(0)
  })

  it('takes the answer from a desktop window only', () => {
    expect(() => resolveCompanionCreated({ id: 1, clientKey: 'w1' }, 'x', { ok: true })).toThrow('remote')
  })
})

describe('launch options', () => {
  it('are derived for the claimed id only, with the checkout dir created', () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    expect(companionLaunchFor('agent-claude-someone-else')).toBeUndefined()
    const launch = companionLaunchFor(companion!.sessionId)
    expect(launch).toEqual({ reviewId: REVIEW, extraReadDir: join(root, 'review-checkouts', REVIEW) })
    expect(existsSync(launch!.extraReadDir)).toBe(true)
  })
})

describe('ending a companion', () => {
  it('a PTY exit clears the claim', () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    onCompanionExited(companion!.sessionId)
    expect(getReview(REVIEW)!.companion).toBeUndefined()
  })

  it('quitting leaves held deliveries for the next start', () => {
    expect(exitSettlesDelivery()).toBe(true)
    markCompanionQuitting()
    expect(exitSettlesDelivery()).toBe(false)
  })

  it('quitting does not', () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    markCompanionQuitting()
    onCompanionExited(companion!.sessionId)
    endCompanionsOfWindow(1)
    expect(getReview(REVIEW)!.companion?.sessionId).toBe(companion!.sessionId)
  })

  it("its window closing ends it, and kills a live one", () => {
    const { companion } = claimCompanion(REVIEW, 2, 'req')
    live.add(companion!.sessionId)
    endCompanionsOfWindow(1)
    expect(getReview(REVIEW)!.companion).toBeDefined()
    endCompanionsOfWindow(2)
    expect(deps.kill).toHaveBeenCalledWith(companion!.sessionId)
    expect(getReview(REVIEW)!.companion).toBeUndefined()
  })
})

describe('spawn guards', () => {
  it('a claimed id launches only as the companion, and no other spawn path may take it', () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    const id = companion!.sessionId
    expect(companionSpawnFor(id, undefined)).toMatchObject({ reviewId: REVIEW })
    expect(companionSpawnFor(id, { kind: 'review', reviewId: REVIEW })).toMatchObject({ reviewId: REVIEW })
    expect(() => companionSpawnFor(id, { kind: 'review', reviewId: 'r_review02' })).toThrow('another review')
    expect(() => assertUnclaimed(id)).toThrow('companion')
    expect(() => assertUnclaimed('agent-claude-plain')).not.toThrow()
  })

  it('refuses an owned spawn whose claim is gone, instead of starting it writable', () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    onCompanionExited(companion!.sessionId)
    expect(() => companionSpawnFor(companion!.sessionId, { kind: 'review', reviewId: REVIEW })).toThrow('claim has ended')
    expect(companionSpawnFor('agent-claude-plain', undefined)).toBeUndefined()
  })

  it("refuses a closed review's claimed id on every path", () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    setReviewStatus(REVIEW, 'discarded')
    expect(() => companionSpawnFor(companion!.sessionId, undefined)).toThrow('companion')
  })
})

describe('timing', () => {
  it('fetches the rubric before claiming, so it cannot eat the create window', async () => {
    let release!: (rubric: string) => void
    deps.rubric = () => new Promise((resolve) => (release = resolve))
    const started = ensureCompanion(REVIEW, 1)
    await flush()
    expect(getReview(REVIEW)!.companion).toBeUndefined()
    release('rubric')
    await flush()
    expect(getReview(REVIEW)!.companion).toBeDefined()
    answerLast({ ok: true })
    await started
  })

  it('does not replace a claim a resume just rebound, before its spawn is live', async () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    expect(rebindCompanionSession({ id: 1 }, REVIEW, companion!.sessionId, 'agent-claude-resumed')).toBe(true)
    await expect(ensureCompanion(REVIEW, 2)).resolves.toBe('agent-claude-resumed')
    expect(sent).toHaveLength(0)
    expect(getReview(REVIEW)!.companion?.sessionId).toBe('agent-claude-resumed')
  })
})

describe('rebind on resume', () => {
  it('refuses when the from-id is a live companion', () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    live.add(companion!.sessionId)
    expect(rebindCompanionSession({ id: 1 }, REVIEW, companion!.sessionId, 'agent-claude-new')).toBe(false)
    expect(getReview(REVIEW)!.companion?.sessionId).toBe(companion!.sessionId)
  })

  it('moves the claim from the right id to the resuming window', () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    expect(rebindCompanionSession({ id: 3 }, REVIEW, 'agent-claude-wrong', 'agent-claude-new')).toBe(false)
    expect(rebindCompanionSession({ id: 3 }, REVIEW, companion!.sessionId, 'agent-claude-new')).toBe(true)
    expect(getReview(REVIEW)!.companion).toMatchObject({ sessionId: 'agent-claude-new', windowId: 3 })
    expect(companionLaunchFor('agent-claude-new')).toBeDefined()
    expect(companionLaunchFor(companion!.sessionId)).toBeUndefined()
    expect(companionInfo(REVIEW, 3)).toMatchObject({ hostedHere: true, live: false, readOnly: 'enforced' })
  })

  it('refuses remote callers', () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    expect(() => rebindCompanionSession({ id: 1, clientKey: 'w1' }, REVIEW, companion!.sessionId, 'agent-claude-new')).toThrow('remote')
    expect(getReview(REVIEW)!.companion?.sessionId).toBe(companion!.sessionId)
  })
})

describe('companion status', () => {
  const report = (terminalId: string, status: 'running' | 'waiting' | 'idle') => ({ worktreePath: '/w', terminalId, status, precise: true })

  it('relays a companion\'s status once per change, for clients of other windows', () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    const id = companion!.sessionId
    expect(noteCompanionStatus(report(id, 'waiting'))).toEqual({ reviewId: REVIEW, sessionId: id, status: 'waiting' })
    expect(noteCompanionStatus(report(id, 'waiting'))).toBeNull()
    expect(companionInfo(REVIEW, 2)).toMatchObject({ hostedHere: false, status: 'waiting' })
  })

  it('ignores sessions that are not companions', () => {
    expect(noteCompanionStatus(report('agent-claude-other', 'waiting'))).toBeNull()
  })

  it('forgets the status when the terminal exits', () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    noteCompanionStatus(report(companion!.sessionId, 'running'))
    onCompanionExited(companion!.sessionId)
    expect(companionInfo(REVIEW, 1)?.status).toBeUndefined()
  })
})

describe('switching agent', () => {
  it('validates the target', async () => {
    await expect(setReviewCompanionAgent(REVIEW, { provider: 'bash' })).rejects.toThrow()
    await expect(setReviewCompanionAgent(REVIEW, { provider: 'codex', model: '--yolo' })).rejects.toThrow()
  })

  it('refuses a model the catalog does not offer, saying why', async () => {
    const catalog = { claude: async () => [], codex: async () => ['gpt-5'], opencode: async () => [], ollama: async () => [] }
    await expect(setReviewCompanionAgent(REVIEW, { provider: 'codex', model: 'gpt-nope' }, catalog)).rejects.toThrow(/doesn't offer/)
    expect(getReview(REVIEW)!.companionAgent).toEqual({ provider: 'claude', model: 'default' })
    await setReviewCompanionAgent(REVIEW, { provider: 'codex', model: 'gpt-5' }, catalog)
    expect(getReview(REVIEW)!.companionAgent).toEqual({ provider: 'codex', model: 'gpt-5' })
  })

  it('stores the agent and ends a running companion', async () => {
    const { companion } = claimCompanion(REVIEW, 1, 'req')
    live.add(companion!.sessionId)
    await setReviewCompanionAgent(REVIEW, { provider: 'codex', model: 'gpt-5', reasoningEffort: 'high' })
    expect(getReview(REVIEW)!.companionAgent).toEqual({ provider: 'codex', model: 'gpt-5#high' })
    expect(deps.kill).toHaveBeenCalledWith(companion!.sessionId)
    expect(getReview(REVIEW)!.companion).toBeUndefined()
  })
})

describe('switching back to Default', () => {
  it('stores the default agent for a null target', () => {
    setReviewCompanionAgent(REVIEW, { provider: 'codex', model: 'gpt-5' })
    setReviewCompanionAgent(REVIEW, null)
    expect(getReview(REVIEW)!.companionAgent).toEqual(defaultCompanionAgent(null))
  })
})

describe('stored agent codec', () => {
  it.each<InteractiveTarget>([
    { provider: 'claude' },
    { provider: 'claude', model: { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
    { provider: 'claude', model: { provider: 'ollama', model: 'qwen3:8b' } },
    { provider: 'codex', model: 'gpt-5', reasoningEffort: 'high' },
    { provider: 'codex', reasoningEffort: 'low' },
    { provider: 'opencode', model: 'opencode/deepseek-v4-flash-free' },
  ])('round-trips %j', (target) => {
    expect(targetFromReviewAgent(reviewAgentFromTarget(target))).toEqual(target)
  })

  it('defaults to Settings, then the last-used agent, then Claude', () => {
    expect(defaultCompanionAgent(null)).toEqual({ provider: 'claude', model: 'default' })
    expect(defaultCompanionAgent({ defaults: {}, submenuAllowlist: [], lastUsed: { provider: 'openai', model: 'gpt-5' } })).toEqual({ provider: 'codex', model: 'gpt-5' })
    expect(
      defaultCompanionAgent({
        defaults: {},
        submenuAllowlist: [],
        lastUsed: { provider: 'openai', model: 'gpt-5' },
        reviewCompanion: { provider: 'claude', model: { provider: 'anthropic', model: 'claude-opus-4' } },
      }),
    ).toEqual({ provider: 'claude', model: 'anthropic:claude-opus-4' })
  })
})
