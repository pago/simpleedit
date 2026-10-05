import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeWindow {
  isDestroyed: () => boolean
  webContents: { id: number; isDestroyed: () => boolean; send: (channel: string, data: unknown) => void }
}

let windows: FakeWindow[] = []

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
}))

import { broadcastToWindows, liveWindowContents } from '../window-broadcast'

function fakeWindow(id: number, state: { window?: boolean; contents?: boolean } = {}): FakeWindow & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    isDestroyed: () => state.window ?? false,
    webContents: {
      id,
      isDestroyed: () => state.contents ?? false,
      send: (channel) => {
        if (state.contents) throw new TypeError('Object has been destroyed')
        sent.push(channel)
      },
    },
  }
}

describe('broadcastToWindows', () => {
  beforeEach(() => { windows = [] })

  it('sends to every live window', () => {
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    windows = [a, b]
    broadcastToWindows('remote:status-changed', {})
    expect(a.sent).toEqual(['remote:status-changed'])
    expect(b.sent).toEqual(['remote:status-changed'])
  })

  // The state a window is in during its WebContents' `destroyed` event: still
  // listed, the window itself not yet destroyed, but `send` throws.
  it('skips a window whose WebContents is already destroyed', () => {
    const closing = fakeWindow(1, { contents: true })
    const live = fakeWindow(2)
    windows = [closing, live]
    expect(() => broadcastToWindows('remote:status-changed', {})).not.toThrow()
    expect(live.sent).toEqual(['remote:status-changed'])
    expect(liveWindowContents().map((wc) => wc.id)).toEqual([2])
  })

  it('skips a destroyed window', () => {
    windows = [fakeWindow(1, { window: true, contents: true })]
    expect(liveWindowContents()).toEqual([])
  })
})
