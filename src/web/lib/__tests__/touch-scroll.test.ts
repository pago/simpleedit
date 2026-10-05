import { describe, it, expect } from 'vitest'
import { createTouchScroller, scrollTarget } from '../touch-scroll'

function harness(pxPerLine = 10, momentum?: () => boolean) {
  let t = 0
  let frames: Array<() => void> = []
  const lines: number[] = []
  const scroller = createTouchScroller({
    pxPerLine: () => pxPerLine,
    onLines: (n) => lines.push(n),
    momentum,
    now: () => t,
    requestFrame: (cb) => { frames.push(() => cb(t)); return frames.length },
    cancelFrame: () => { frames = [] },
  })
  return {
    scroller,
    lines,
    total: () => lines.reduce((a, b) => a + b, 0),
    advance(ms: number) { t += ms },
    /** Run queued frames 16ms apart until the fling settles. */
    flush(max = 1000) {
      for (let i = 0; i < max && frames.length; i++) {
        const next = frames
        frames = []
        t += 16
        for (const f of next) f()
      }
      return frames.length
    },
  }
}

describe('createTouchScroller', () => {
  it('dragging the content up scrolls towards later output', () => {
    const h = harness()
    h.scroller.start(200)
    h.advance(200)
    h.scroller.move(170)
    expect(h.total()).toBe(3)
  })

  it('dragging down scrolls back', () => {
    const h = harness()
    h.scroller.start(100)
    h.advance(200)
    h.scroller.move(125)
    expect(h.total()).toBe(-2)
  })

  it('accumulates sub-line moves instead of rounding each away', () => {
    const h = harness(8)
    h.scroller.start(100)
    for (let i = 1; i <= 12; i++) {
      h.advance(50)
      h.scroller.move(100 - i * 2)
    }
    expect(h.total()).toBe(3)
  })

  it('a slow lift does not fling', () => {
    const h = harness()
    h.scroller.start(200)
    for (let i = 1; i <= 10; i++) {
      h.advance(50)
      h.scroller.move(200 - i * 5)
    }
    h.scroller.end()
    expect(h.flush()).toBe(0)
    expect(h.total()).toBe(5)
  })

  it('a flick keeps scrolling in the same direction, then stops', () => {
    const h = harness()
    h.scroller.start(400)
    for (let i = 1; i <= 5; i++) {
      h.advance(10)
      h.scroller.move(400 - i * 20)
    }
    const dragged = h.total()
    h.scroller.end()
    expect(h.flush()).toBe(0)
    expect(h.total()).toBeGreaterThan(dragged)
    expect(h.lines.every((n) => n > 0)).toBe(true)
  })

  it('a finger that stopped before lifting does not fling', () => {
    const h = harness()
    h.scroller.start(400)
    h.advance(10)
    h.scroller.move(300)
    h.advance(300)
    h.scroller.end()
    expect(h.flush()).toBe(0)
  })

  it('touching again stops a fling', () => {
    const h = harness()
    h.scroller.start(400)
    for (let i = 1; i <= 5; i++) {
      h.advance(10)
      h.scroller.move(400 - i * 20)
    }
    h.scroller.end()
    h.scroller.start(300)
    const before = h.total()
    expect(h.flush()).toBe(0)
    expect(h.total()).toBe(before)
  })

  function flick(h: ReturnType<typeof harness>): void {
    h.scroller.start(400)
    for (let i = 1; i <= 5; i++) {
      h.advance(10)
      h.scroller.move(400 - i * 20)
    }
  }

  it('does not fling where momentum is off, but still follows the finger', () => {
    const h = harness(10, () => false)
    flick(h)
    expect(h.total()).toBe(10)
    h.scroller.end()
    expect(h.flush()).toBe(0)
    expect(h.total()).toBe(10)
  })

  it('stops a fling once momentum is turned off', () => {
    let allowed = true
    const h = harness(10, () => allowed)
    flick(h)
    h.scroller.end()
    allowed = false
    const before = h.total()
    expect(h.flush()).toBe(0)
    expect(h.total()).toBe(before)
  })

  it('stop() ends a fling', () => {
    const h = harness()
    flick(h)
    h.scroller.end()
    h.scroller.stop()
    const before = h.total()
    expect(h.flush()).toBe(0)
    expect(h.total()).toBe(before)
  })

  // Pinch: one finger flicks, a second lands, the first lifts. The flick's
  // samples are stale by then and must not turn into a fling.
  it('a cancelled gesture neither follows the finger nor flings on release', () => {
    const h = harness()
    flick(h)
    h.scroller.cancel()
    const before = h.total()
    h.advance(10)
    h.scroller.move(200)
    h.scroller.end()
    expect(h.flush()).toBe(0)
    expect(h.total()).toBe(before)
  })

  it('does nothing before the terminal has a cell size', () => {
    const h = harness(0)
    h.scroller.start(200)
    h.advance(100)
    h.scroller.move(0)
    expect(h.lines).toEqual([])
  })
})

describe('scrollTarget', () => {
  it('scrolls the scrollback of a plain shell or an inline TUI', () => {
    expect(scrollTarget('normal', 'none')).toBe('scrollback')
  })

  // X10 reports presses only, never the wheel: a wheel report would go nowhere.
  it('keeps the scrollback under X10 tracking', () => {
    expect(scrollTarget('normal', 'x10')).toBe('scrollback')
    expect(scrollTarget('alternate', 'x10')).toBe('app')
  })

  it('tells the app when it tracks the mouse or owns the screen', () => {
    expect(scrollTarget('alternate', 'none')).toBe('app')
    expect(scrollTarget('alternate', 'any')).toBe('app')
    expect(scrollTarget('normal', 'vt200')).toBe('app')
  })
})
