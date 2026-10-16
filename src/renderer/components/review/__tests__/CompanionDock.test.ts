import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import CompanionDock from '../CompanionDock.svelte'
import { initAgentStatusListeners } from '../../../stores/agent-status.svelte'
import type { ReviewCompanionInfo } from '../../../../shared/review-room-ipc'
import { REVIEW_ID, review, stubApi } from './fixtures'

const local = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; provider?: string; pendingResume?: { sessionId: string }; owner?: { kind: 'review'; reviewId: string } }>,
  resume: vi.fn(),
}))

vi.mock('../../terminal/Terminal.svelte', async () => ({ default: (await import('./StubTerminal.svelte')).default }))
vi.mock('../../../stores/sessions.svelte', () => ({
  sessionsStore: {
    get: (id: string) => local.sessions.find((s) => s.id === id),
    sessions: () => local.sessions,
    resumePlaceholder: local.resume,
  },
}))

const COMPANION = { sessionId: 'sess-c1', windowId: 1, agent: { provider: 'claude', model: '' }, claimRequestId: 'q1' }
let api: ReturnType<typeof stubApi>
let info: ReviewCompanionInfo | null

beforeEach(() => {
  local.sessions = []
  local.resume.mockReset()
  info = null
  api = stubApi((channel) => (channel === 'review:companion-info' ? info : undefined))
  initAgentStatusListeners()
})

function hostedHere(over: Partial<ReviewCompanionInfo> = {}): void {
  info = { reviewId: REVIEW_ID, sessionId: 'sess-c1', windowId: 1, hostedHere: true, live: true, readOnly: 'enforced', ...over }
  local.sessions = [{ id: 'sess-c1', provider: 'claude', owner: { kind: 'review', reviewId: REVIEW_ID } }]
}

describe('CompanionDock', () => {
  it('without a companion: says it starts on the first question, and Start claims one', async () => {
    render(CompanionDock, { props: { reviewId: REVIEW_ID, review: review() } })
    expect(screen.getByTestId('companion-status')).toHaveTextContent('Not started')
    expect(screen.getByRole('button', { name: '▸ Terminal' })).toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(api.invoke).toHaveBeenCalledWith('review:companion-start', REVIEW_ID)
    expect(screen.getByTestId('companion-status')).toHaveTextContent('Starting…')
  })

  it('stays collapsed, even when the companion needs you; the toggle mounts its terminal', async () => {
    hostedHere()
    render(CompanionDock, { props: { reviewId: REVIEW_ID, review: review({ companion: COMPANION }) } })
    api.emit('agent:status', { terminalId: 'sess-c1', worktreePath: '/p', status: 'waiting', precise: true })
    expect(await screen.findByTestId('needs-you')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-terminal')).toBeNull()

    await fireEvent.click(screen.getByRole('button', { name: '▸ Terminal' }))
    expect(screen.getByTestId('stub-terminal')).toHaveAttribute('data-terminal-id', 'sess-c1')
    expect(screen.getByRole('button', { name: '▾ Terminal' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('says read-only is by instruction where the agent can’t enforce it', async () => {
    hostedHere({ readOnly: 'by-instruction' })
    render(CompanionDock, { props: { reviewId: REVIEW_ID, review: review({ companion: COMPANION }) } })
    api.emit('agent:status', { terminalId: 'sess-c1', worktreePath: '/p', status: 'idle', precise: true })
    await vi.waitFor(() => expect(screen.getByTestId('companion-status').getAttribute('title')).toMatch(/Read-only by instruction/))
  })

  it('in another window: no terminal here', async () => {
    info = { reviewId: REVIEW_ID, sessionId: 'sess-c1', windowId: 2, hostedHere: false, live: true, readOnly: 'enforced' }
    render(CompanionDock, { props: { reviewId: REVIEW_ID, review: review({ companion: { ...COMPANION, windowId: 2 } }) } })
    expect(await screen.findByText('Terminal lives in another window')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '▸ Terminal' })).toBeDisabled()
  })

  it('after a restart: Resume brings back the owned placeholder', async () => {
    info = { reviewId: REVIEW_ID, sessionId: 'sess-c1', windowId: 1, hostedHere: true, live: false, readOnly: 'enforced' }
    local.sessions = [{ id: 'sess-new', provider: 'claude', owner: { kind: 'review', reviewId: REVIEW_ID }, pendingResume: { sessionId: 'claude-uuid' } }]
    render(CompanionDock, { props: { reviewId: REVIEW_ID, review: review({ companion: COMPANION }) } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    expect(local.resume).toHaveBeenCalledWith('sess-new')
  })

  it('after a restart with reassigned window ids, a local placeholder still offers Resume', async () => {
    info = { reviewId: REVIEW_ID, sessionId: 'sess-c1', windowId: 7, hostedHere: false, live: false, readOnly: 'enforced' }
    local.sessions = [{ id: 'sess-new', provider: 'claude', owner: { kind: 'review', reviewId: REVIEW_ID }, pendingResume: { sessionId: 'claude-uuid' } }]
    render(CompanionDock, { props: { reviewId: REVIEW_ID, review: review({ companion: { ...COMPANION, windowId: 7 } }) } })
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(screen.queryByText('Terminal lives in another window')).not.toBeInTheDocument()
  })

  it('a stale claim with nothing to resume offers Start', async () => {
    info = { reviewId: REVIEW_ID, sessionId: 'sess-c1', windowId: 1, hostedHere: true, live: false, readOnly: 'enforced' }
    render(CompanionDock, { props: { reviewId: REVIEW_ID, review: review({ companion: COMPANION }) } })
    expect(await screen.findByText('Ended')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Start a new companion' }))
    expect(api.invoke).toHaveBeenCalledWith('review:companion-start', REVIEW_ID)
  })

  it('doesn’t ask main again on every running/idle flip', async () => {
    hostedHere()
    render(CompanionDock, { props: { reviewId: REVIEW_ID, review: review({ companion: COMPANION }) } })
    const infoCalls = (): number => api.invoke.mock.calls.filter((c) => c[0] === 'review:companion-info').length
    await vi.waitFor(() => expect(infoCalls()).toBe(1))
    api.emit('agent:status', { terminalId: 'sess-c1', worktreePath: '/p', status: 'running', precise: true })
    api.emit('agent:status', { terminalId: 'sess-c1', worktreePath: '/p', status: 'idle', precise: true })
    expect(await screen.findByText('Idle')).toBeInTheDocument()
    expect(infoCalls()).toBe(1)
  })

  it('asks again when the claim moves to another session', async () => {
    hostedHere()
    const view = render(CompanionDock, { props: { reviewId: REVIEW_ID, review: review({ companion: COMPANION }) } })
    const infoCalls = (): number => api.invoke.mock.calls.filter((c) => c[0] === 'review:companion-info').length
    await vi.waitFor(() => expect(infoCalls()).toBe(1))
    await view.rerender({ reviewId: REVIEW_ID, review: review({ companion: { ...COMPANION, sessionId: 'sess-c2' } }) })
    await vi.waitFor(() => expect(infoCalls()).toBe(2))
  })
})
