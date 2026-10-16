import { render, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Terminal from '../Terminal.svelte'

/**
 * Sessions that aren't on screen stay mounted inside a display:none wrapper.
 * FitAddon doesn't fail there, it shrinks xterm to a few columns, and the PTY
 * never hears about it. Output written meanwhile wraps at that width and the
 * agent, whose size never changed, has no reason to repaint it.
 */

const LINE = 'x'.repeat(100)
const PTY = { cols: 120, rows: 30 }
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'app:client-key') return 'desk'
    if (channel === 'pty:backlog') return { data: LINE, start: 0, end: LINE.length, ...PTY }
    return undefined
  })
  vi.stubGlobal('api', { invoke, on: () => () => {}, once: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  document.head.querySelectorAll('style[data-test-layout]').forEach((el) => el.remove())
})

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

function hiddenHost(): HTMLElement {
  // Tailwind isn't loaded here. Without these the container has no height,
  // and FitAddon gives up rather than shrinking the terminal as it does in
  // the app.
  const style = document.createElement('style')
  style.textContent = '.h-full { height: 100% } .w-full { width: 100% }'
  style.dataset.testLayout = ''
  document.head.append(style)
  const host = document.createElement('div')
  host.style.cssText = 'width:1000px;height:500px;display:none'
  document.body.append(host)
  return host
}

function rowCount(host: HTMLElement): number {
  return host.querySelectorAll('.xterm-rows > div').length
}

function firstRowText(host: HTMLElement): string {
  return host.querySelector('.xterm-rows > div')?.textContent?.trimEnd() ?? ''
}

function sizesSent(): Array<[number, number]> {
  return invoke.mock.calls
    .filter(([channel]) => channel === 'pty:resize' || channel === 'pty:claim')
    .map(([, , cols, rows]) => [cols as number, rows as number])
}

describe('Terminal mounted hidden', () => {
  it('renders the replay at the PTY width, then fits once shown', async () => {
    const host = hiddenHost()
    render(Terminal, { target: host, props: { terminalId: 't1', active: false } })

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('pty:backlog', 't1'))
    await nextFrame()
    await nextFrame()

    host.style.display = ''
    await nextFrame()
    await nextFrame()

    // Replayed at xterm's 80-column default, this row would hold 80 x's.
    expect(firstRowText(host)).toBe(LINE)
    expect(sizesSent().length).toBeGreaterThan(0)
    for (const [cols] of sizesSent()) expect(cols).toBeGreaterThan(100)
  })

  it('is never fitted while hidden, even when it becomes the active session', async () => {
    const host = hiddenHost()
    const view = render(Terminal, { target: host, props: { terminalId: 't2', active: false } })

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('pty:backlog', 't2'))
    await nextFrame()
    await nextFrame()
    expect(rowCount(host)).toBe(PTY.rows)

    await view.rerender({ terminalId: 't2', active: true })
    await nextFrame()
    await nextFrame()

    // A hidden fit leaves a handful of rows; the PTY has 30.
    expect(rowCount(host)).toBe(PTY.rows)
    expect(sizesSent()).toEqual([])
  })
})
