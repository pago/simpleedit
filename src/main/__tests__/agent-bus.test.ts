import { describe, it, expect, beforeEach } from 'vitest'
import {
  MAX_HOPS,
  MAX_MESSAGE_CHARS,
  captureImplicitReplies,
  drain,
  enqueue,
  formatForDelivery,
  listPeers,
  pendingCount,
  resetBus,
  resolvePeer,
  senderOf,
  syncPeers,
  waitForReply,
  type Peer,
} from '../agent-bus'

function peer(terminalId: string, label: string): Peer {
  return { terminalId, label, provider: 'claude', worktreePath: `/repo/${label}`, status: 'idle' }
}

beforeEach(() => {
  resetBus()
  syncPeers([peer('claude-a', 'alpha'), peer('claude-b', 'beta')])
})

describe('agent-bus — addressing', () => {
  it('resolves by terminal id and by label', () => {
    expect(resolvePeer('claude-a')).toEqual({ peer: expect.objectContaining({ terminalId: 'claude-a' }) })
    expect(resolvePeer('beta')).toEqual({ peer: expect.objectContaining({ terminalId: 'claude-b' }) })
  })

  it('resolves a label case-insensitively', () => {
    expect(resolvePeer('BETA')).toEqual({ peer: expect.objectContaining({ terminalId: 'claude-b' }) })
  })

  it('refuses an ambiguous label and names the candidates', () => {
    syncPeers([peer('claude-a', 'dup'), peer('claude-b', 'dup')])
    const result = resolvePeer('dup')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('Ambiguous')
    expect((result as { error: string }).error).toContain('claude-a')
  })

  it('lists known sessions when the address is unknown', () => {
    const result = resolvePeer('nope')
    expect((result as { error: string }).error).toContain('alpha')
  })

  it('excludes the caller from its own peer list', () => {
    expect(listPeers('claude-a').map((p) => p.terminalId)).toEqual(['claude-b'])
  })

  it('drops mail and peers that disappear from a sync', () => {
    enqueue({ from: 'claude-a', to: 'claude-b', text: 'hi' })
    expect(pendingCount('claude-b')).toBe(1)
    syncPeers([peer('claude-a', 'alpha')])
    expect(pendingCount('claude-b')).toBe(0)
    expect(resolvePeer('claude-b')).toHaveProperty('error')
  })
})

describe('agent-bus — sending', () => {
  it('queues a message for the target', () => {
    const result = enqueue({ from: 'claude-a', to: 'beta', text: 'look at PR 42' })
    expect(result).toHaveProperty('message')
    expect(pendingCount('claude-b')).toBe(1)
  })

  it('refuses an empty message', () => {
    expect(enqueue({ from: 'claude-a', to: 'beta', text: '   ' })).toHaveProperty('error')
  })

  it('refuses a message over the size cap, telling the sender to use pointers', () => {
    const result = enqueue({ from: 'claude-a', to: 'beta', text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) })
    expect((result as { error: string }).error).toContain('pointers')
  })

  it('refuses self-messaging', () => {
    expect(enqueue({ from: 'claude-a', to: 'claude-a', text: 'hi' })).toHaveProperty('error')
  })

  it('rate-limits a spamming sender', () => {
    let lastError: string | undefined
    for (let i = 0; i < 40; i++) {
      const r = enqueue({ from: 'claude-a', to: 'beta', text: `m${i}` })
      if ('error' in r) lastError = r.error
    }
    expect(lastError).toContain('Rate limit')
  })
})

describe('agent-bus — delivery', () => {
  it('drain empties the mailbox so mail is delivered once', () => {
    enqueue({ from: 'claude-a', to: 'beta', text: 'one' })
    expect(drain('claude-b')).toHaveLength(1)
    expect(drain('claude-b')).toHaveLength(0)
  })

  it('formats delivery so the recipient knows the sender and how to answer', () => {
    enqueue({ from: 'claude-a', to: 'beta', text: 'is the migration done?', expectsReply: true })
    const text = formatForDelivery(drain('claude-b'))
    expect(text).toContain('alpha')
    expect(text).toContain('is the migration done?')
    expect(text).toContain('WAITING')
    expect(text).toContain('reply')
  })
})

describe('agent-bus — replies', () => {
  it('routes an explicit reply back to the original sender', () => {
    const sent = enqueue({ from: 'claude-a', to: 'beta', text: 'q' })
    const id = (sent as { message: { id: string } }).message.id
    expect(senderOf(id)).toBe('claude-a')

    drain('claude-b')
    enqueue({ from: 'claude-b', to: 'claude-a', text: 'a', replyTo: id })
    expect(pendingCount('claude-a')).toBe(1)
  })

  it("treats the recipient's final turn text as an implicit reply", () => {
    const sent = enqueue({ from: 'claude-a', to: 'beta', text: 'q', expectsReply: true })
    const id = (sent as { message: { id: string } }).message.id
    drain('claude-b')

    const replies = captureImplicitReplies('claude-b', 'yes, it landed in #123')
    expect(replies).toHaveLength(1)
    expect(replies[0].replyTo).toBe(id)
    expect(replies[0].to).toBe('claude-a')
  })

  it('only captures an implicit reply once per delivery', () => {
    enqueue({ from: 'claude-a', to: 'beta', text: 'q', expectsReply: true })
    drain('claude-b')
    expect(captureImplicitReplies('claude-b', 'first')).toHaveLength(1)
    expect(captureImplicitReplies('claude-b', 'second')).toHaveLength(0)
  })

  it('does not capture a reply for mail that never asked for one', () => {
    enqueue({ from: 'claude-a', to: 'beta', text: 'fyi' })
    drain('claude-b')
    expect(captureImplicitReplies('claude-b', 'ok')).toHaveLength(0)
  })

  it('settles a blocked sender with the implicit reply instead of queueing it twice', async () => {
    const sent = enqueue({ from: 'claude-a', to: 'beta', text: 'q', expectsReply: true })
    const id = (sent as { message: { id: string } }).message.id
    drain('claude-b')

    const waiting = waitForReply(id, 5000)
    captureImplicitReplies('claude-b', 'the answer')

    const reply = await waiting
    expect(reply?.text).toBe('the answer')
    // The waiter consumed it; queueing as well would show the sender the same
    // answer a second time on its next turn.
    expect(pendingCount('claude-a')).toBe(0)
  })

  it('resolves a waiter with null on timeout rather than hanging', async () => {
    const sent = enqueue({ from: 'claude-a', to: 'beta', text: 'q', expectsReply: true })
    const id = (sent as { message: { id: string } }).message.id
    await expect(waitForReply(id, 10)).resolves.toBeNull()
  })

  it('unblocks a waiter when the peer answers with nothing', async () => {
    const sent = enqueue({ from: 'claude-a', to: 'beta', text: 'q', expectsReply: true })
    const id = (sent as { message: { id: string } }).message.id
    drain('claude-b')

    const waiting = waitForReply(id, 5000)
    captureImplicitReplies('claude-b', '   ')
    await expect(waiting).resolves.toBeNull()
  })

  it('unblocks a waiter when the peer session disappears', async () => {
    const sent = enqueue({ from: 'claude-a', to: 'beta', text: 'q', expectsReply: true })
    const id = (sent as { message: { id: string } }).message.id
    drain('claude-b')

    const waiting = waitForReply(id, 5000)
    syncPeers([peer('claude-a', 'alpha')])
    await expect(waiting).resolves.toBeNull()
  })
})

describe('agent-bus — loop control', () => {
  it('stops a reply chain once it exceeds the hop budget', () => {
    // Ping-pong: each reply answers the previous one, so hops climb by 1.
    let currentId = (enqueue({ from: 'claude-a', to: 'claude-b', text: 'start' }) as { message: { id: string } })
      .message.id
    let from = 'claude-b'
    let to = 'claude-a'
    let lastError: string | undefined

    for (let i = 0; i < MAX_HOPS + 3; i++) {
      const r = enqueue({ from, to, text: `turn ${i}`, replyTo: currentId })
      if ('error' in r) {
        lastError = r.error
        break
      }
      currentId = r.message.id
      ;[from, to] = [to, from]
    }

    expect(lastError).toContain('hops')
  })
})
