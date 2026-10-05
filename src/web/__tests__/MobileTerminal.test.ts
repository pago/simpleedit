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
let resizes: Array<[number, number]>
let backlogData: string

function emit(channel: string, data: unknown): void {
  for (const fn of [...(listeners.get(channel) ?? [])]) fn(data)
}

const connection: RemoteConnection = {
  state: () => 'open',
  reconnect: () => {},
  identity: () => ({ windowId: 1, clientKey: 'w1.1' }),
  onStateChange: () => () => {},
  setKey: () => {},
    onIdentity: (fn) => {
    fn({ windowId: 1, clientKey: 'w1.1' })
    return () => {}
  },
}

beforeEach(() => {
  listeners = new Map()
  writes = []
  resizes = []
  backlogData = ''
  vi.stubGlobal('api', {
    on: (channel: string, cb: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), cb])
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((fn) => fn !== cb))
    },
    invoke: async (channel: string, _id: string, arg?: unknown, rows?: unknown) => {
      if (channel === 'pty:backlog') return { data: backlogData, start: 0, end: backlogData.length }
      if (channel === 'pty:write') writes.push(String(arg))
      if (channel === 'pty:resize') resizes.push([Number(arg), Number(rows)])
      return undefined
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

type Instance = { pressKey: (key: 'up' | 'down' | 'enter') => void }

let unmountTerminal: () => void

function mount(): Instance {
  const { component, unmount } = render(MobileTerminal, { terminalId: 't1', connection })
  unmountTerminal = unmount
  return component as unknown as Instance
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

/**
 * Swipes, through the real xterm, in each mode an agent's TUI actually uses:
 * Codex and Claude Code's default renderer are inline on the normal buffer;
 * Claude Code's `tui: fullscreen` and OpenCode take the alternate screen and
 * turn on SGR mouse tracking.
 */
describe('MobileTerminal touch scrolling', () => {
  function terminalEl(): HTMLElement {
    return document.querySelector<HTMLElement>('[data-testid="mobile-terminal"]')!
  }

  function touchAt(id: number, x: number, y: number): Touch {
    return new Touch({ identifier: id, target: terminalEl(), clientX: x, clientY: y })
  }

  function fire(type: string, touches: Touch[], changed: Touch[]): void {
    terminalEl().dispatchEvent(new TouchEvent(type, {
      touches, targetTouches: touches, changedTouches: changed, bubbles: true, cancelable: true,
    }))
  }

  function origin(): { x: number; y: number } {
    const box = terminalEl().getBoundingClientRect()
    return { x: box.left + 20, y: box.top + box.height / 2 }
  }

  function swipe(dy: number): void {
    const { x, y: y0 } = origin()
    const at = (y: number): Touch => touchAt(1, x, y)
    fire('touchstart', [at(y0)], [at(y0)])
    const steps = 8
    for (let i = 1; i <= steps; i++) fire('touchmove', [at(y0 + (dy * i) / steps)], [at(y0 + (dy * i) / steps)])
    fire('touchend', [], [at(y0 + dy)])
  }

  /**
   * A fast drag in real time, so the release carries velocity. Returns with
   * the finger still down unless `lift` is set.
   */
  async function flick(dy: number, lift = true): Promise<void> {
    const { x, y: y0 } = origin()
    const at = (y: number): Touch => touchAt(1, x, y)
    fire('touchstart', [at(y0)], [at(y0)])
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      await sleep(10)
      fire('touchmove', [at(y0 + (dy * i) / steps)], [at(y0 + (dy * i) / steps)])
    }
    if (lift) fire('touchend', [], [at(y0 + dy)])
  }

  function visibleText(): string {
    return document.querySelector('.xterm-rows')?.textContent ?? ''
  }

  const longBacklog = (): string => Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\r\n')

  /** The screen shows the same lines across `ms` — nothing is scrolling it. */
  async function expectStill(ms = 300): Promise<void> {
    await sleep(50)
    const before = visibleText()
    await sleep(ms)
    expect(visibleText()).toBe(before)
  }

  it('scrolls back through the scrollback on the normal buffer, without typing', async () => {
    backlogData = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\r\n')
    mount()
    await waitFor(() => expect(visibleText()).toContain('line 99'))

    swipe(120)
    await waitFor(() => expect(visibleText()).not.toContain('line 99'))
    expect(writes).toEqual([])
  })

  it('sends SGR wheel reports to a TUI that tracks the mouse', async () => {
    backlogData = '\x1b[?1049h\x1b[?1000h\x1b[?1006h'
    mount()
    await waitFor(() => {
      writes.length = 0
      swipe(-80)
      expect(writes.length).toBeGreaterThan(0)
    })
    expect(writes.every((w) => /^\x1b\[<65;\d+;\d+M$/.test(w))).toBe(true)

    await waitFor(() => {
      writes.length = 0
      swipe(80)
      expect(writes.length).toBeGreaterThan(0)
      expect(writes.every((w) => /^\x1b\[<64;\d+;\d+M$/.test(w))).toBe(true)
    })
  })

  it('sends arrows in the cursor-key mode of a bare alternate screen', async () => {
    backlogData = '\x1b[?1049h\x1b[?1h'
    mount()
    await waitFor(() => {
      writes.length = 0
      swipe(-80)
      expect(writes.length).toBeGreaterThan(0)
    })
    expect(new Set(writes)).toEqual(new Set(['\x1bOB']))
  })

  // X10 reports presses only. Treated as wheel tracking, a swipe became a
  // wheel event xterm then dropped, and nothing moved.
  it('scrolls the scrollback under X10 mouse tracking', async () => {
    backlogData = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\r\n') + '\x1b[?9h'
    mount()
    await waitFor(() => expect(visibleText()).toContain('line 99'))

    swipe(120)
    await waitFor(() => expect(visibleText()).not.toContain('line 99'))
    expect(writes).toEqual([])
  })

  it('sends arrows under X10 mouse tracking on the alternate screen', async () => {
    backlogData = '\x1b[?1049h\x1b[?9h'
    mount()
    await waitFor(() => {
      writes.length = 0
      swipe(-80)
      expect(writes.length).toBeGreaterThan(0)
    })
    expect(new Set(writes)).toEqual(new Set(['\x1b[B']))
  })

  it('a flick keeps scrolling the scrollback after the finger lifts', async () => {
    backlogData = longBacklog()
    mount()
    await waitFor(() => expect(visibleText()).toContain('line 399'))

    await flick(240)
    await sleep(50)
    const atLift = visibleText()
    await sleep(200)
    expect(visibleText()).not.toBe(atLift)
  })

  // Momentum into a TUI would keep typing into it after the finger is gone.
  it('a flick sends nothing more to a TUI once the finger lifts', async () => {
    backlogData = '\x1b[?1049h\x1b[?1000h\x1b[?1006h'
    mount()
    await waitFor(() => {
      writes.length = 0
      swipe(-80)
      expect(writes.length).toBeGreaterThan(0)
    })

    writes.length = 0
    await flick(-240)
    const sent = writes.length
    expect(sent).toBeGreaterThan(0)
    await sleep(300)
    expect(writes.length).toBe(sent)
  })

  it('the process exiting stops a fling', async () => {
    backlogData = longBacklog()
    mount()
    await waitFor(() => expect(visibleText()).toContain('line 399'))

    await flick(240)
    emit('pty:exit', { id: 't1', exitCode: 0 })
    await expectStill()
  })

  it('unmounting stops a fling', async () => {
    backlogData = longBacklog()
    mount()
    await waitFor(() => expect(visibleText()).toContain('line 399'))

    await flick(240)
    unmountTerminal()
    await sleep(50)
    const frames = vi.spyOn(window, 'requestAnimationFrame')
    await sleep(200)
    expect(frames).not.toHaveBeenCalled()
  })

  // A pinch starts as one finger. When the second lands and one lifts, the
  // first finger's samples are stale and must not become a fling.
  it('a second finger ends the swipe without a fling', async () => {
    backlogData = longBacklog()
    mount()
    await waitFor(() => expect(visibleText()).toContain('line 399'))

    await flick(240, false)
    const { x, y } = origin()
    const first = touchAt(1, x, y + 240)
    const second = touchAt(2, x + 40, y + 240)
    fire('touchstart', [first, second], [second])
    fire('touchend', [second], [first])
    await expectStill()
  })
})

describe('MobileTerminal resizing', () => {
  const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

  // The keyboard sliding in shrinks the container a little every frame. (Width
  // here: without the app's stylesheet the terminal's height is its content's.)
  it('resizes the PTY once the container settles, not on every frame', async () => {
    const box = document.createElement('div')
    box.style.cssText = 'width: 480px'
    document.body.append(box)
    try {
      render(MobileTerminal, { target: box, props: { terminalId: 't1', connection } })
      await sleep(300)
      resizes.length = 0

      for (let width = 460; width >= 240; width -= 20) {
        box.style.width = `${width}px`
        await frame()
      }
      await sleep(300)
      expect(resizes).toHaveLength(1)
    } finally {
      box.remove()
    }
  })
})
