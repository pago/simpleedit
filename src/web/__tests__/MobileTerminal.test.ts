import { render, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import MobileTerminal from '../MobileTerminal.svelte'
import type { RemoteConnection } from '../api-shim'

/**
 * The wiring between the accessory bar and the terminal's cursor-key mode.
 *
 * `keys.test.ts` proves `keyBytes` encodes both forms, and would go on passing
 * if the terminal always passed `false` — which is precisely the bug that
 * existed. This drives a real xterm: the mode is set the only way it ever is,
 * by the PTY writing `CSI ?1h` as OUTPUT, and then the key is pressed.
 */

type Listener = (data: unknown) => void

let listeners: Map<string, Listener[]>
let writes: string[]
let backlogData: string

function emit(channel: string, data: unknown): void {
  for (const fn of [...(listeners.get(channel) ?? [])]) fn(data)
}

const connection: RemoteConnection = {
  state: () => 'open',
  reconnect: () => {},
  identity: () => ({ windowId: 1, clientKey: 'w1.1' }),
  onStateChange: () => () => {},
  onIdentity: (fn) => {
    fn({ windowId: 1, clientKey: 'w1.1' })
    return () => {}
  },
}

beforeEach(() => {
  listeners = new Map()
  writes = []
  backlogData = ''
  vi.stubGlobal('api', {
    on: (channel: string, cb: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), cb])
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((fn) => fn !== cb))
    },
    invoke: async (channel: string, _id: string, arg?: unknown) => {
      if (channel === 'pty:backlog') return { data: backlogData, start: 0, end: backlogData.length }
      if (channel === 'pty:write') writes.push(String(arg))
      return undefined
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

type Instance = { pressKey: (key: 'up' | 'down' | 'enter') => void }

function mount(): Instance {
  const { component } = render(MobileTerminal, { terminalId: 't1', connection })
  return component as unknown as Instance
}

/**
 * Press until the write lands. xterm's parser drains asynchronously, so the
 * mode is not set the instant the bytes are handed over — retrying the press
 * is what makes this deterministic rather than timing-dependent.
 */
async function pressUntil(terminal: Instance, expected: string): Promise<void> {
  await waitFor(() => {
    writes.length = 0
    terminal.pressKey('up')
    expect(writes).toEqual([expected])
  })
}

describe('MobileTerminal key encoding', () => {
  it('sends the normal cursor form by default', async () => {
    const terminal = mount()
    await pressUntil(terminal, '\x1b[A')
  })

  // Every full-screen TUI sets DECCKM, and that is exactly where a phone needs
  // the arrows. A terminal hard-coding the normal form sends the wrong bytes.
  it('sends the application cursor form once the PTY asks for it', async () => {
    backlogData = '\x1b[?1h'
    const terminal = mount()
    await pressUntil(terminal, '\x1bOA')
  })

  it('follows the mode back when the PTY leaves it', async () => {
    backlogData = '\x1b[?1h'
    const terminal = mount()
    await pressUntil(terminal, '\x1bOA')

    emit('pty:data', { id: 't1', data: '\x1b[?1l', offset: backlogData.length })
    await pressUntil(terminal, '\x1b[A')
  })

  it('sends the same bytes for the non-cursor keys in either mode', async () => {
    backlogData = '\x1b[?1h'
    const terminal = mount()
    await pressUntil(terminal, '\x1bOA')

    writes.length = 0
    terminal.pressKey('enter')
    expect(writes).toEqual(['\r'])
  })
})
