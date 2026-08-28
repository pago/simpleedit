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

  const sizedElsewhere = $derived(
    sizeOwner !== null && myClientKey !== '' && sizeOwner !== myClientKey,
  )

  let term: Terminal | undefined
  let fitAddon: FitAddon | undefined

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

    const attachment: PtyAttachment = attachPty(terminalId, {
      write: (data) => term?.write(data),
      onExit: (code) => {
        exitCode = code
        term?.write(`\r\n[Process exited with code ${code}]`)
      },
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

    const observer = new ResizeObserver(() => {
      if (!term || !fitAddon || el.offsetWidth === 0 || el.offsetHeight === 0) return
      fitAddon.fit()
      // Unconditional. Main drops a non-owner's resize, so gating here would
      // only duplicate that decision from stale local state — and get it wrong
      // whenever the container reflowed while this client was not the owner.
      void window.api.invoke('pty:resize', terminalId, term.cols, term.rows)
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
      offState()
      offIdentity()
      observer.disconnect()
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
  <div bind:this={containerEl} class="h-full w-full" data-testid="mobile-terminal"></div>
  {#if sizedElsewhere}
    <!-- Main sizes the PTY for whoever claimed it last. When that is not this
         client, this view is fitted to its own container and the terminal is
         not — say so, rather than letting it read as a rendering bug. -->
    <div
      class="pointer-events-none absolute right-2 top-2 z-10 rounded bg-zinc-800/90 px-2 py-1 text-[10px] text-zinc-400 shadow"
    >Sized by another device</div>
  {/if}
  {#if exitCode !== null}
    <div
      class="pointer-events-none absolute left-2 top-2 z-10 rounded bg-zinc-800/90 px-2 py-1 text-[10px] text-amber-400 shadow"
    >Session ended</div>
  {/if}
</div>
