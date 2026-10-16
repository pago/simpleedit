import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionCreateRequest } from '../../shared/ipc-types'
import { createSessionOnce, resetSessionCreate, resolveSessionCreate } from '../session-create'

/**
 * A review companion is a hidden, owned session that only main may start. The
 * phone reaches `session:create`, so whatever it sends must never turn into an
 * owner or the companion's launch options: main forwards a request rebuilt
 * from known fields, and the renderer creates the session from that alone.
 */

function recordingRenderer() {
  const sent: Record<string, unknown>[] = []
  return {
    sent,
    send(channel: string, data: unknown): void {
      if (channel !== 'session:create-request') return
      const payload = data as Record<string, unknown>
      sent.push(payload)
      resolveSessionCreate(String(payload['correlationId']), { ok: true, terminalId: 'agent-1', label: 'Brief' })
    },
    isDestroyed: () => false,
  }
}

beforeEach(() => resetSessionCreate())
afterEach(() => resetSessionCreate())

describe('session:create and owned sessions', () => {
  it('never forwards an owner or companion launch options a client sent', async () => {
    const renderer = recordingRenderer()
    const request = {
      requestId: 'req-owner',
      brief: 'Review this',
      owner: { kind: 'review', reviewId: 'r_review01' },
      reviewCompanion: true,
      target: {
        provider: 'claude',
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6', owner: { kind: 'review', reviewId: 'r_review01' } },
        owner: { kind: 'review', reviewId: 'r_review01' },
        reviewCompanion: true,
      },
    } as unknown as SessionCreateRequest

    await expect(createSessionOnce(request, renderer)).resolves.toMatchObject({ terminalId: 'agent-1' })
    expect(renderer.sent).toHaveLength(1)
    const [payload] = renderer.sent
    expect(Object.keys(payload!).sort()).toEqual(['brief', 'correlationId', 'label', 'target'])
    expect(payload!['target']).toEqual({ provider: 'claude', model: { provider: 'anthropic', model: 'claude-sonnet-4-6' } })
  })

  it('forwards no owner when the client names no target either', async () => {
    const renderer = recordingRenderer()
    const request = {
      requestId: 'req-plain',
      brief: 'Review this',
      owner: { kind: 'review', reviewId: 'r_review01' },
    } as unknown as SessionCreateRequest

    await createSessionOnce(request, renderer)
    expect(renderer.sent[0]).not.toHaveProperty('owner')
    expect(renderer.sent[0]).not.toHaveProperty('reviewCompanion')
  })
})
