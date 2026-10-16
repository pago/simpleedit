import { describe, it, expect, beforeEach, vi } from 'vitest'
import { companionLine, companionState, initCompanionStatusListener, reviewSubmits } from '../lib/review-phone.svelte'
import type { ReviewCompanionInfo } from '../../shared/review-room-ipc'

const CLAIM = { companion: { sessionId: 'agent-claude-c1', windowId: 1, agent: { provider: 'claude', model: '' }, claimRequestId: 'q' }, status: 'open' as const }
const info = (over: Partial<ReviewCompanionInfo> = {}): ReviewCompanionInfo => ({
  reviewId: 'r_review01',
  sessionId: 'agent-claude-c1',
  windowId: 1,
  hostedHere: false,
  live: true,
  readOnly: 'enforced',
  ...over,
})

describe('companionLine', () => {
  it('says the first question starts one, with nothing to press', () => {
    expect(companionLine({ status: 'open' }, null, undefined)).toMatchObject({ tone: 'muted', canStart: false })
  })

  it('sends "needs you" to the Mac, where its terminal is', () => {
    const line = companionLine(CLAIM, info(), 'waiting')
    expect(line.tone).toBe('needs-you')
    expect(line.text).toMatch(/answer on the Mac/)
  })

  it('offers a new companion when the claimed one is not running', () => {
    expect(companionLine(CLAIM, info({ live: false }), undefined)).toMatchObject({ tone: 'error', canStart: true })
  })

  it('waits for main’s answer about the current claim, not an earlier one', () => {
    expect(companionLine(CLAIM, info({ sessionId: 'agent-claude-old', live: false }), undefined)).toMatchObject({ canStart: false, tone: 'muted' })
  })

  it('has nothing to start on a closed review', () => {
    expect(companionLine({ ...CLAIM, status: 'submitted' }, info({ live: false }), undefined).canStart).toBe(false)
  })
})

describe('companion status relay', () => {
  beforeEach(() => companionState._reset())

  it('takes the relayed status for a companion hosted in another window', () => {
    const listeners: Array<(p: unknown) => void> = []
    vi.stubGlobal('api', { invoke: vi.fn(), on: (_c: string, h: (p: unknown) => void) => (listeners.push(h), () => {}) })
    initCompanionStatusListener()
    listeners.forEach((h) => h({ reviewId: 'r_review01', sessionId: 'agent-claude-c1', status: 'waiting' }))
    expect(companionState.status('agent-claude-c1')).toBe('waiting')
  })

  it('seeds the status from companion-info', async () => {
    vi.stubGlobal('api', { invoke: vi.fn(async () => info({ status: 'running' })), on: () => () => {} })
    await companionState.load('r_review01')
    expect(companionState.info('r_review01')?.live).toBe(true)
    expect(companionState.status('agent-claude-c1')).toBe('running')
  })
})

describe('reviewSubmits', () => {
  beforeEach(() => reviewSubmits._reset())

  it('latches per review until unlatched', () => {
    reviewSubmits.latch('r_a')
    expect(reviewSubmits.latched('r_a')).toBe(true)
    expect(reviewSubmits.latched('r_b')).toBe(false)
    reviewSubmits.unlatch('r_a')
    expect(reviewSubmits.latched('r_a')).toBe(false)
  })

  it('reports any submit in flight, for the project switch', () => {
    reviewSubmits.begin('r_a')
    expect(reviewSubmits.any()).toBe(true)
    reviewSubmits.end('r_a')
    expect(reviewSubmits.any()).toBe(false)
  })
})
