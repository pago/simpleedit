import { describe, it, expect, afterEach } from 'vitest'
import { trackVisualViewport, visualViewport } from '../visual-viewport.svelte'

class FakeViewport extends EventTarget {
  height = window.innerHeight
  offsetTop = 0
  scale = 1

  set(next: Partial<Pick<FakeViewport, 'height' | 'offsetTop' | 'scale'>>, event = 'resize'): void {
    Object.assign(this, next)
    this.dispatchEvent(new Event(event))
  }
}

let stop: () => void = () => {}

function track(): { vv: FakeViewport; root: HTMLElement } {
  const vv = new FakeViewport()
  const root = document.createElement('div')
  stop = trackVisualViewport(root, vv as unknown as VisualViewport)
  return { vv, root }
}

const vars = (root: HTMLElement): { height: string; top: string } => ({
  height: root.style.getPropertyValue('--vv-height'),
  top: root.style.getPropertyValue('--vv-top'),
})

afterEach(() => {
  stop()
  visualViewport.keyboardOpen = false
})

describe('trackVisualViewport', () => {
  it('pins the app to the visual viewport from the start', () => {
    const { root } = track()
    expect(vars(root)).toEqual({ height: `${window.innerHeight}px`, top: '0px' })
    expect(visualViewport.keyboardOpen).toBe(false)
  })

  it('reads a keyboard-sized shrink as the keyboard opening, and closing', () => {
    const { vv, root } = track()
    vv.set({ height: window.innerHeight - 300, offsetTop: 40 })
    expect(vars(root)).toEqual({ height: `${window.innerHeight - 300}px`, top: '40px' })
    expect(visualViewport.keyboardOpen).toBe(true)

    vv.set({ height: window.innerHeight, offsetTop: 0 })
    expect(visualViewport.keyboardOpen).toBe(false)
  })

  it('does not mistake a browser toolbar showing for a keyboard', () => {
    const { vv } = track()
    vv.set({ height: window.innerHeight - 60 })
    expect(visualViewport.keyboardOpen).toBe(false)
  })

  it('follows a pan of the visual viewport', () => {
    const { vv, root } = track()
    vv.set({ height: window.innerHeight - 300, offsetTop: 120 }, 'scroll')
    expect(vars(root).top).toBe('120px')
  })

  // A pinch shrinks the visual viewport just as a keyboard does. Following it
  // would shrink the app, refit the terminal and resize the PTY mid-zoom.
  it('holds the last layout while pinch-zoomed, and resumes at scale 1', () => {
    const { vv, root } = track()
    const unzoomed = vars(root)

    vv.set({ scale: 2, height: window.innerHeight / 2, offsetTop: 200 })
    vv.set({ offsetTop: 260 }, 'scroll')
    expect(vars(root)).toEqual(unzoomed)
    expect(visualViewport.keyboardOpen).toBe(false)

    vv.set({ scale: 1, height: window.innerHeight - 300, offsetTop: 0 })
    expect(vars(root).height).toBe(`${window.innerHeight - 300}px`)
    expect(visualViewport.keyboardOpen).toBe(true)
  })

  it('stops listening once stopped', () => {
    const { vv, root } = track()
    stop()
    vv.set({ height: window.innerHeight - 300 })
    expect(vars(root).height).toBe(`${window.innerHeight}px`)
  })
})
