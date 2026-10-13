import { describe, it, expect } from 'vitest'
import { attentionTooltip, sessionsAttention, type SessionAttentionSummary } from '../sessionsAttention'

function s(over: Partial<SessionAttentionSummary> = {}): SessionAttentionSummary {
  return { exited: false, status: 'idle', unseen: false, ...over }
}

describe('sessionsAttention', () => {
  it('is none with no sessions or only quiet ones', () => {
    expect(sessionsAttention([]).level).toBe('none')
    expect(sessionsAttention([s(), s({ status: 'initializing' })]).level).toBe('none')
  })

  it('ranks error > waiting > unseen > running', () => {
    const running = s({ status: 'running' })
    const unseen = s({ unseen: true })
    const waiting = s({ status: 'waiting' })
    expect(sessionsAttention([running]).level).toBe('running')
    expect(sessionsAttention([running, unseen]).level).toBe('unseen')
    expect(sessionsAttention([running, unseen, waiting]).level).toBe('waiting')
    expect(sessionsAttention([running, unseen, waiting, s({ status: 'error' })]).level).toBe('error')
    expect(sessionsAttention([running, unseen, waiting, s({ exited: true, status: 'running' })]).level).toBe('error')
  })

  it('counts unseen only while the session is idle', () => {
    expect(sessionsAttention([s({ status: 'running', unseen: true })]).counts).toEqual({
      error: 0,
      waiting: 0,
      unseen: 0,
      running: 1,
    })
  })

  it('counts each session once, at its most urgent level', () => {
    const { counts } = sessionsAttention([
      s({ status: 'waiting' }),
      s({ status: 'waiting' }),
      s({ unseen: true }),
      s({ exited: true, unseen: true }),
    ])
    expect(counts).toEqual({ error: 1, waiting: 2, unseen: 1, running: 0 })
  })
})

describe('attentionTooltip', () => {
  it('lists non-zero counts most urgent first', () => {
    expect(attentionTooltip({ error: 0, waiting: 2, unseen: 1, running: 0 })).toBe('2 awaiting input · 1 finished')
    expect(attentionTooltip({ error: 1, waiting: 0, unseen: 0, running: 3 })).toBe('1 crashed or errored · 3 working')
  })

  it('says so when nothing needs attention', () => {
    expect(attentionTooltip({ error: 0, waiting: 0, unseen: 0, running: 0 })).toBe('Nothing needs attention')
  })
})
