import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initAgentMailListeners, queuedMailCount } from '../agent-mail.svelte'

let handlers: Record<string, (d: unknown) => void>
let dispose: () => void
let seed: Record<string, string[]>

beforeEach(() => {
  handlers = {}
  seed = {}
  vi.stubGlobal('api', {
    on: (channel: string, cb: (d: unknown) => void) => {
      handlers[channel] = cb
      return () => {
        delete handlers[channel]
      }
    },
    once: vi.fn(),
    invoke: vi.fn(async () => seed),
  })
  dispose = initAgentMailListeners()
})

afterEach(() => {
  // Module state outlives a test; exiting the terminals used here empties it.
  for (const id of ['b', 'c']) handlers['pty:exit']?.({ id, exitCode: 0 })
  dispose()
  vi.unstubAllGlobals()
})

function sent(messageId: string, to: string): void {
  handlers['agent-message:sent']?.({ messageId, from: 'a', fromLabel: 'alpha', to, text: 't', expectsReply: false })
}

describe('agent-mail store', () => {
  it('counts mail per recipient until it is delivered', () => {
    sent('m1', 'b')
    sent('m2', 'b')
    sent('m3', 'c')
    expect(queuedMailCount('b')).toBe(2)
    expect(queuedMailCount('c')).toBe(1)

    handlers['agent-message:delivered']?.({ terminalId: 'b', messageIds: ['m1'] })
    expect(queuedMailCount('b')).toBe(1)
    handlers['agent-message:delivered']?.({ terminalId: 'b', messageIds: ['m2'] })
    expect(queuedMailCount('b')).toBe(0)
  })

  it('clears mail that was dropped', () => {
    sent('m1', 'b')
    handlers['agent-message:dropped']?.({ terminalId: 'b', messageIds: ['m1'] })
    expect(queuedMailCount('b')).toBe(0)
  })

  it("rebuilds from main's unread mail after a reload", async () => {
    dispose()
    seed = { c: ['m9'] }
    dispose = initAgentMailListeners()
    sent('m10', 'c')
    await vi.waitFor(() => expect(queuedMailCount('c')).toBe(2))
  })

  it('drops a session that exits', () => {
    sent('m1', 'b')
    handlers['pty:exit']?.({ id: 'b', exitCode: 0 })
    expect(queuedMailCount('b')).toBe(0)
  })
})
