/**
 * A vertical swipe, as whole terminal lines — with a fling after it.
 *
 * xterm has no touch handling of its own: its viewport scrolls on wheel
 * events, so a swipe never moves it and the gesture falls through to the
 * page. This turns finger travel into signed line steps (positive = later
 * output, which is what dragging the content up means) and leaves what a step
 * DOES to the caller, because that depends on the terminal's mode: scrollback
 * on the normal buffer, input to the app under a full-screen TUI.
 *
 * Distance is accumulated, not rounded per move: a slow drag delivers many
 * sub-line moves, and rounding each would swallow them.
 */

export interface TouchScrollOptions {
  /** CSS px of travel per step — a cell's height, so the content tracks the finger. */
  pxPerLine: () => number
  onLines: (lines: number) => void
  /**
   * Whether a release may fling. Asked on release and again every frame, so a
   * fling stops the moment the terminal switches to a mode where it can't
   * scroll by itself.
   */
  momentum?: () => boolean
  now?: () => number
  requestFrame?: (cb: (time: number) => void) => number
  cancelFrame?: (handle: number) => void
}

export interface TouchScroller {
  start(y: number): void
  move(y: number): void
  end(): void
  /** Stop a fling in progress, e.g. because output or a tap needs the screen. */
  stop(): void
  /**
   * Forget the gesture and stop any fling: the touches are no longer a swipe
   * (a second finger landed), so lifting one must not fling from the samples
   * of the first.
   */
  cancel(): void
}

/** Only the last stretch of a drag says how fast the finger left. */
const VELOCITY_WINDOW_MS = 100
/** Below this (px/ms) a release is a lift, not a flick. */
const MIN_FLING_VELOCITY = 0.3
/** Velocity kept per 16ms frame — iOS's own decay is close to this. */
const FRICTION_PER_FRAME = 0.95
const STOP_VELOCITY = 0.02

export function createTouchScroller(options: TouchScrollOptions): TouchScroller {
  const now = options.now ?? (() => performance.now())
  const requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb))
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle))
  const momentum = options.momentum ?? (() => true)

  let lastY = 0
  let tracking = false
  let remainder = 0
  let samples: Array<{ y: number; t: number }> = []
  let frame: number | null = null

  function travel(px: number): void {
    const perLine = options.pxPerLine()
    if (!(perLine > 0)) return
    remainder += px / perLine
    const lines = Math.trunc(remainder)
    if (lines === 0) return
    remainder -= lines
    options.onLines(lines)
  }

  function stop(): void {
    if (frame !== null) cancelFrame(frame)
    frame = null
  }

  function fling(velocity: number): void {
    let v = velocity
    let last = now()
    const step = (): void => {
      if (!momentum()) { frame = null; return }
      const t = now()
      const dt = Math.max(0, t - last)
      last = t
      travel(v * dt)
      v *= Math.pow(FRICTION_PER_FRAME, dt / 16)
      frame = Math.abs(v) < STOP_VELOCITY ? null : requestFrame(step)
    }
    frame = requestFrame(step)
  }

  return {
    start(y) {
      stop()
      tracking = true
      lastY = y
      remainder = 0
      samples = [{ y, t: now() }]
    },
    move(y) {
      if (!tracking) return
      const t = now()
      travel(lastY - y)
      lastY = y
      samples.push({ y, t })
      while (samples.length > 2 && t - samples[0].t > VELOCITY_WINDOW_MS) samples.shift()
    },
    end() {
      if (!tracking) return
      tracking = false
      const first = samples[0]
      const last = samples[samples.length - 1]
      const dt = last.t - first.t
      // A finger that stopped and then lifted has no velocity, whatever it did
      // earlier in the drag.
      if (dt <= 0 || now() - last.t > VELOCITY_WINDOW_MS) return
      const velocity = (first.y - last.y) / dt
      if (Math.abs(velocity) >= MIN_FLING_VELOCITY && momentum()) fling(velocity)
    },
    stop,
    cancel() {
      stop()
      tracking = false
      samples = []
    },
  }
}

/**
 * Where a step goes. Scrollback exists only on the normal buffer and only
 * when the app is not tracking the wheel; otherwise the app owns scrolling
 * (Claude Code's fullscreen TUI, OpenCode) or has no scrollback at all, and
 * must be told the way a wheel would tell it.
 *
 * X10 tracking reports button presses only — never the wheel — so it leaves
 * the normal buffer's scrollback alone, and on the alternate screen xterm
 * turns the wheel into arrows exactly as with no tracking at all.
 */
export function scrollTarget(
  bufferType: 'normal' | 'alternate',
  mouseTracking: 'none' | 'x10' | 'vt200' | 'drag' | 'any',
): 'scrollback' | 'app' {
  const reportsWheel = mouseTracking !== 'none' && mouseTracking !== 'x10'
  return bufferType === 'normal' && !reportsWheel ? 'scrollback' : 'app'
}
