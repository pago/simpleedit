<script lang="ts">
  /**
   * The real PTY, on a phone.
   *
   * Not a parsed view of it. Claude presents genuine TUIs for decisions —
   * plan approval, model selection — that are alt-screen and redraw-driven and
   * change between releases; anything that re-renders an interpretation of
   * them will eventually show a confident lie about what is being approved.
   * So this is xterm over the same byte stream the desktop sees, through the
   * same attachment (`renderer/lib/pty-attach.ts`).
   *
   * ── Lifetime ────────────────────────────────────────────────────────────
   * The attachment belongs to this component: mounted with it, disposed with
   * it, and unaffected by the socket underneath — which reconnects on its own.
   * A reconnect leaves a gap in `pty:data`, so `resync` fills it from the
   * backlog by byte offset, and a new socket means a NEW client key, so the
   * ownership comparison is re-read rather than cached.
   */
  import { onMount } from 'svelte'
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import '@xterm/xterm/css/xterm.css'
  import { attachPty, type PtyAttachment } from '../renderer/lib/pty-attach'
  import { hasUserAttention } from '../renderer/lib/attention'
  import { keyBytes, type AccessoryKey } from './lib/keys'
  import { createTouchScroller, scrollTarget } from './lib/touch-scroll'
  import type { RemoteConnection } from './api-shim'
  import type { PtyClientId } from '../shared/ipc-types'

  interface Props {
    terminalId: string
    connection: RemoteConnection
  }

  let { terminalId, connection }: Props = $props()

  let containerEl: HTMLDivElement | undefined = $state()
  let sizeOwner = $state<PtyClientId | null>(null)
  let myClientKey = $state('')
  let exitCode = $state<number | null>(null)
  let missedOutput = $state(false)

  const sizedElsewhere = $derived(
    sizeOwner !== null && myClientKey !== '' && sizeOwner !== myClientKey,
  )

  const RESIZE_SETTLE_MS = 100

  let term: Terminal | undefined
  let fitAddon: FitAddon | undefined

  /**
   * Send what a physical key sends.
   *
   * Which bytes that is depends on the terminal's cursor-key mode, and the
   * terminal is the only thing that knows it — so the accessory bar names the
   * key and this translates it.
   */
  export function pressKey(key: AccessoryKey): void {
    const application = term?.modes.applicationCursorKeysMode ?? false
    void window.api.invoke('pty:write', terminalId, keyBytes(key, application))
  }

  export function dismissGapNotice(): void {
    missedOutput = false
  }

  /** Fit first, then claim: a claim carries the geometry it is claiming with. */
  function fitAndClaim(): void {
    if (!term || !fitAddon || !containerEl) return
    if (containerEl.offsetWidth === 0 || containerEl.offsetHeight === 0) return
    fitAddon.fit()
    if (hasUserAttention(true)) {
      sizeOwner = myClientKey || null
      void window.api.invoke('pty:claim', terminalId, term.cols, term.rows)
    } else {
      // Still reported. Main drops it if someone else owns the PTY, so a
      // backgrounded tab cannot take the size from whoever is looking.
      void window.api.invoke('pty:resize', terminalId, term.cols, term.rows)
    }
  }

  /**
   * Swipes scroll. xterm only scrolls on wheel events, so a step goes to the
   * scrollback directly when there is one, and otherwise becomes a synthetic
   * wheel event — xterm already turns those into exactly what the app asked
   * for: an SGR/X10 wheel report under mouse tracking (Claude Code's
   * fullscreen TUI, OpenCode), an arrow in the current cursor-key mode on a
   * bare alternate screen.
   *
   * Only scrollback flings. A fling into an app would keep typing wheel
   * reports or arrows into it after the finger has gone — into a TUI that may
   * be a picker moving its selection — so there it scrolls only while the
   * finger moves.
   */
  function bindTouchScroll(el: HTMLElement): { stop: () => void; dispose: () => void } {
    // Wheel reports carry a cell. Where the swipe began is inside the
    // terminal by definition; the finger may since have left it.
    let point = { x: 0, y: 0 }

    function cellHeight(): number {
      const screen = term?.element?.querySelector<HTMLElement>('.xterm-screen')
      return screen && term ? screen.clientHeight / term.rows : 0
    }

    function target(): 'scrollback' | 'app' | null {
      return term ? scrollTarget(term.buffer.active.type, term.modes.mouseTrackingMode) : null
    }

    function scrollBy(lines: number): void {
      if (!term?.element) return
      if (target() === 'scrollback') {
        term.scrollLines(lines)
        return
      }
      for (let i = 0; i < Math.abs(lines); i++) {
        term.element.dispatchEvent(new WheelEvent('wheel', {
          deltaY: Math.sign(lines),
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: point.x,
          clientY: point.y,
          bubbles: true,
          cancelable: true,
        }))
      }
    }

    const scroller = createTouchScroller({
      pxPerLine: cellHeight,
      onLines: scrollBy,
      momentum: () => target() === 'scrollback',
    })

    const onStart = (ev: TouchEvent): void => {
      // A second finger is a pinch: it belongs to the browser's zoom.
      if (ev.touches.length !== 1) { scroller.cancel(); return }
      const t = ev.touches[0]
      point = { x: t.clientX, y: t.clientY }
      scroller.start(t.clientY)
    }
    const onMove = (ev: TouchEvent): void => {
      if (ev.touches.length !== 1) return
      scroller.move(ev.touches[0].clientY)
      // `touch-action: pinch-zoom` already keeps a one-finger pan off the page;
      // this is for the WebKit builds that honour it late or not at all.
      ev.preventDefault()
    }
    const onEnd = (): void => { scroller.end() }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return {
      stop: () => scroller.stop(),
      dispose: () => {
        scroller.stop()
        el.removeEventListener('touchstart', onStart)
        el.removeEventListener('touchmove', onMove)
        el.removeEventListener('touchend', onEnd)
        el.removeEventListener('touchcancel', onEnd)
      },
    }
  }

  onMount(() => {
    const el = containerEl
    if (!el) return

    term = new Terminal({
      cursorBlink: true,
      // Small: a phone is ~390 CSS px wide and a TUI needs columns more than
      // it needs legible glyphs at arm's length.
      fontSize: 11,
      lineHeight: 1.1,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
        selectionBackground: '#3f3f46',
      },
    })
    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(el)

    term.onData((data: string) => {
      void window.api.invoke('pty:write', terminalId, data)
    })

    const touch = bindTouchScroll(el)

    const attachment: PtyAttachment = attachPty(terminalId, {
      write: (data) => term?.write(data),
      onExit: (code) => {
        exitCode = code
        touch.stop()
        // Main drops the owner entry on exit. Distinct from a RELEASE, which
        // resyncs geometry — there is nothing left here to size, and claiming
        // it would name this client the owner of a PTY main has none for.
        sizeOwner = null
        term?.write(`\r\n[Process exited with code ${code}]`)
      },
      // The backlog could not reach back far enough to cover the disconnect.
      // The arithmetic still lines up, but an escape sequence was cut in half
      // somewhere — so say the screen may be wrong rather than let it read as
      // a rendering bug.
      onGap: () => { missedOutput = true },
      onOwnerChange: (owner) => {
        sizeOwner = owner
        // Nobody owns it — the previous owner's transport went away and the PTY
        // is still at ITS geometry. Ownership moving without geometry following
        // is how a terminal ends up drawing into a viewport of the wrong size,
        // and neither the ResizeObserver nor a claim has an event left to fire.
        if (owner === null) fitAndClaim()
      },
    })

    // The container has no size until layout has run once.
    requestAnimationFrame(fitAndClaim)

    // The keyboard animates in and out, and the container follows it frame by
    // frame. Fitting every frame would send the PTY 10-20 resizes — each one a
    // SIGWINCH and a full redraw by the TUI — so the fit waits for it to settle.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (!term || !fitAddon || el.offsetWidth === 0 || el.offsetHeight === 0) return
        fitAddon.fit()
        // Unconditional. Main drops a non-owner's resize, so gating here would
        // only duplicate that decision from stale local state — and get it wrong
        // whenever the container reflowed while this client was not the owner.
        void window.api.invoke('pty:resize', terminalId, term.cols, term.rows)
      }, RESIZE_SETTLE_MS)
    })
    observer.observe(el)

    // Coming back to the tab is attention, and it is also when the phone's
    // keyboard has just changed the viewport under us.
    const onAttention = (): void => { fitAndClaim() }
    window.addEventListener('focus', onAttention)
    document.addEventListener('visibilitychange', onAttention)

    // A new socket is a new identity, so this cannot be read once and kept.
    const offIdentity = connection.onIdentity((identity) => { myClientKey = identity.clientKey })

    // While the socket was down, `pty:data` went nowhere. The backlog's byte
    // offsets make the catch-up exact — no duplicated screen, no silent hole —
    // and the claim goes again because the key that held it has just died.
    let wasOpen = connection.state() === 'open'
    const offState = connection.onStateChange((state) => {
      const open = state === 'open'
      if (open && !wasOpen) {
        attachment.resync()
        fitAndClaim()
      }
      wasOpen = open
    })

    return () => {
      touch.dispose()
      offState()
      offIdentity()
      observer.disconnect()
      clearTimeout(resizeTimer)
      window.removeEventListener('focus', onAttention)
      document.removeEventListener('visibilitychange', onAttention)
      attachment.dispose()
      term?.dispose()
      term = undefined
      fitAddon = undefined
    }
  })
</script>

<div class="relative h-full w-full overflow-hidden bg-zinc-950">
  <div bind:this={containerEl} class="h-full w-full touch-pinch-zoom" data-testid="mobile-terminal"></div>
  {#if sizedElsewhere}
    <!-- Main sizes the PTY for whoever claimed it last. When that is not this
         client, this view is fitted to its own container and the terminal is
         not — say so, rather than letting it read as a rendering bug. -->
    <div
      class="pointer-events-none absolute right-2 top-2 z-10 rounded bg-zinc-800/90 px-2 py-1 text-[10px] text-zinc-400 shadow"
    >Sized by another device</div>
  {/if}
  {#if missedOutput}
    <button
      type="button"
      onclick={dismissGapNotice}
      class="absolute inset-x-2 bottom-2 z-10 rounded bg-amber-950/95 px-2 py-1 text-left text-[10px] text-amber-300 shadow"
    >Output was missed while disconnected — this screen may be incomplete. Tap to dismiss.</button>
  {/if}
  {#if exitCode !== null}
    <div
      class="pointer-events-none absolute left-2 top-2 z-10 rounded bg-zinc-800/90 px-2 py-1 text-[10px] text-amber-400 shadow"
    >Session ended</div>
  {/if}
</div>
