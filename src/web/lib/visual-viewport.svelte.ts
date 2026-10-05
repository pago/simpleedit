/**
 * The part of the screen the on-screen keyboard leaves.
 *
 * iOS does not shrink the layout viewport for the keyboard — `100%`, `100vh`
 * and `100dvh` all stay full height — it shrinks the VISUAL viewport and pans
 * the page under it to keep the focused field in view. A full-height layout
 * therefore ends up with its top (the terminal) panned off-screen and its
 * bottom (the composer's Send) under the keyboard. So the app is pinned to the
 * visual viewport instead: `#app` reads `--vv-height` and `--vv-top`.
 */

/** A keyboard is far taller than any toolbar the browser shows or hides. */
const KEYBOARD_MIN_PX = 150

export const visualViewport = $state({ keyboardOpen: false })

type Viewport = Pick<VisualViewport, 'height' | 'offsetTop' | 'scale' | 'addEventListener' | 'removeEventListener'>

export function trackVisualViewport(
  root: HTMLElement = document.documentElement,
  vv: Viewport | null = window.visualViewport,
): () => void {
  if (!vv) return () => {}

  const update = (): void => {
    // A pinch shrinks the visual viewport too, and following it would reflow
    // the app (and resize the PTY) under the zoom. Zoomed, the page is meant
    // to sit still and be panned around; zooming back out fires again.
    if (vv.scale !== 1) return
    root.style.setProperty('--vv-height', `${vv.height}px`)
    root.style.setProperty('--vv-top', `${vv.offsetTop}px`)
    visualViewport.keyboardOpen = window.innerHeight - vv.height > KEYBOARD_MIN_PX
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
  }
}
