<script lang="ts">
  import { resolveDropPath } from '../../lib/dropped-paths'
  import type { AgentProviderId } from '../../../shared/ipc-types'
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { WebLinksAddon } from '@xterm/addon-web-links'
  import '@xterm/xterm/css/xterm.css'
  import { sessionsStore } from '../../stores/sessions.svelte'
  import { capabilitiesFor } from '../../stores/agent-capabilities.svelte'
  import { clientKey } from '../../lib/clientKey'
  import { hasUserAttention as isAttended } from '../../lib/attention'
  import { attachPty, type PtyAttachment } from '../../lib/pty-attach'

  interface Props {
    terminalId: string
    active?: boolean
    /** Absent for a plain terminal — there's no agent in front of the shell. */
    provider?: AgentProviderId
    ontitlechange?: (title: string) => void
  }

  let { terminalId, active = true, provider, ontitlechange }: Props = $props()

  // How this terminal's agent wants keys and dropped paths handled. A plain
  // terminal (no provider) gets shell semantics: never swallow Shift+Enter, and
  // quote paths rather than newline-separating them.
  const caps = $derived(capabilitiesFor(provider))
  const shiftEnter = $derived(caps?.shiftEnter ?? 'native')
  const droppedPath = $derived(caps?.droppedPath ?? 'shell-escaped')

  let containerEl: HTMLDivElement | undefined = $state()
  let isDropTarget = $state(false)

  let term: Terminal | undefined
  let fitAddon: FitAddon | undefined
  let attachment: PtyAttachment | undefined
  let resizeObserver: ResizeObserver | undefined

  // Scroll position preservation across tab switches
  let savedViewportY: number | undefined
  let wasAtBottom = true

  // A PTY has one size but can have several clients attached (a second desktop
  // window on the same session, later a phone), and main honours a resize only
  // from the client that claimed it. Claim on genuine user attention only: a
  // client that re-claimed on reconnect or on background layout churn would
  // take the size away from whoever is actually looking at the terminal.
  //
  // Sending a resize is NOT gated on owning it. Main already drops a
  // non-owner's, so a renderer-side gate only duplicated that decision from
  // stale local state — and got it wrong whenever the container reflowed while
  // this client happened not to be the owner.
  /** Main's last word on who sizes this PTY. null until it has said anything. */
  let sizeOwner = $state<string | null>(null)
  /** This transport's key, for reading `pty:owner-changed`. '' until it lands. */
  let myClientKey = $state('')
  void clientKey().then((k) => { myClientKey = k })

  /** Main has named an owner, and it is not us. */
  const sizedElsewhere = $derived(
    sizeOwner !== null && myClientKey !== '' && sizeOwner !== myClientKey,
  )

  /** Is the user looking at THIS terminal, in this window, right now? */
  function hasUserAttention(): boolean {
    return isAttended(active)
  }

  /**
   * Take the size, handing over the geometry this client is actually rendering.
   * Callers must fit first — a claim carrying stale dimensions is the bug this
   * argument list exists to prevent.
   */
  function claimPty(id: string): void {
    if (!term) return
    sizeOwner = myClientKey || null
    void window.api.invoke('pty:claim', id, term.cols, term.rows)
  }

  /**
   * Re-assert this view's geometry on the PTY.
   *
   * Called when main says the PTY is UNOWNED — the client that was sizing it
   * went away. Ownership moving without geometry following is how a terminal
   * ends up drawing into a viewport of the wrong height: the ResizeObserver
   * fires only on a container change and `pty:claim` only on an attention
   * change, so a window already sitting on this terminal has no event left and
   * would render 40-column output in a 200-column view indefinitely.
   */
  function resyncGeometry(id: string): void {
    if (!term || !fitAddon || !containerEl) return
    if (containerEl.offsetWidth === 0 || containerEl.offsetHeight === 0) return
    fitPreservingScroll()
    // Attention takes the size outright; anything else just reports it, which
    // an unowned PTY accepts.
    if (hasUserAttention()) claimPty(id)
    else window.api.invoke('pty:resize', id, term.cols, term.rows)
  }

  function isScrolledToBottom(): boolean {
    if (!term) return true
    const buf = term.buffer.active
    return buf.viewportY >= buf.baseY
  }

  /** Run fitAddon.fit() while preserving the user's scroll position. */
  function fitPreservingScroll(): void {
    if (!fitAddon || !term) return
    const atBottom = isScrolledToBottom()
    const prevViewportY = term.buffer.active.viewportY
    fitAddon.fit()
    if (atBottom) {
      term.scrollToBottom()
    } else {
      term.scrollToLine(prevViewportY)
    }
  }

  // Regression guard for issue #88: more than one setup event per terminalId
  // means two Terminal components attached to the same PTY (id-mint collision
  // across simultaneously-mounting TerminalTabs). Zero cost in prod (sink
  // isn't set).
  function recordLifecycle(event: 'setup' | 'cleanup', id: string): void {
    const sink = (
      window as unknown as {
        __simpleeditTerminalLifecycle__?: Array<{
          event: 'setup' | 'cleanup'
          id: string
          t: number
        }>
      }
    ).__simpleeditTerminalLifecycle__
    if (Array.isArray(sink)) {
      sink.push({ event, id, t: Date.now() })
    }
  }

  function setup(el: HTMLDivElement, id: string): void {
    cleanup()
    recordLifecycle('setup', id)

    term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
        selectionBackground: '#3f3f46'
      }
    })

    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon((_event, url) => {
      window.api.invoke('app:open-external', url)
    }))

    term.open(el)

    // Small delay to ensure the element is laid out before fitting
    requestAnimationFrame(() => {
      fitAddon?.fit()
    })

    // Shift+Enter must mean "newline", not "submit". Agents that don't handle it
    // themselves need the CSI-u sequence (kitty keyboard protocol) written to
    // the PTY; the rest — and plain shells — are left alone.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.shiftKey) {
        if (e.type === 'keydown' && shiftEnter === 'escape-newline') {
          e.preventDefault()
          window.api.invoke('pty:write', id, '\x1b[13;2u')
        }
        return false
      }
      return true
    })

    // Propagate terminal title changes (e.g. Claude Code sets ✳/⠂ session name)
    term.onTitleChange((title: string) => {
      ontitlechange?.(title)
    })

    // Send keystrokes to the PTY
    term.onData((data: string) => {
      window.api.invoke('pty:write', id, data)
    })

    // Receive data from the PTY.
    // When the user has scrolled up, preserve their viewport position so
    // incoming output doesn't yank them to the bottom (or top after a reflow).
    function writeChunk(data: string): void {
      if (!term) return
      const atBottom = isScrolledToBottom()
      const prevViewportY = term.buffer.active.viewportY
      term.write(data)
      if (!atBottom) {
        term.scrollToLine(prevViewportY)
      }
    }

    // Backlog replay, live output, exit and ownership all live in the shared
    // attachment — the phone renders the same stream through the same code,
    // which is the point: a second implementation of this would eventually
    // disagree with the PTY about what the user is looking at.
    attachment = attachPty(id, {
      write: writeChunk,
      onExit: (exitCode) => {
        // Main drops the owner entry on exit, so this client's belief about it
        // has to go too — a dead terminal must not keep claiming to be sized by
        // somebody. Distinct from an ownership RELEASE, which resyncs geometry;
        // there is nothing left here to size.
        sizeOwner = null
        if (term) term.write(`\r\n[Process exited with code ${exitCode}]`)
      },
      // Not a gate on anything — it is what lets this view say it is being
      // sized by another device instead of silently rendering at a width the
      // PTY abandoned.
      onOwnerChange: (owner) => {
        sizeOwner = owner
        // Nobody owns it: the previous owner's transport is gone and the PTY is
        // still at ITS geometry. Say what this view is actually rendering.
        if (owner === null) resyncGeometry(id)
      },
    })

    // Auto-resize on container size change.
    // Guard against zero dimensions: ResizeObserver fires when a tab is hidden
    // (display:none), which would cause fitAddon to calculate 0 columns and
    // corrupt the PTY's line wrapping.
    // Always told to main. Main applies it only for the owner, so an unwatched
    // window reflowing still cannot resize what someone else is reading — and
    // the client that IS the owner is never silenced by a stale local belief
    // that it is not.
    resizeObserver = new ResizeObserver(() => {
      if (fitAddon && el.offsetWidth > 0 && el.offsetHeight > 0) {
        fitPreservingScroll()
        if (term) {
          window.api.invoke('pty:resize', id, term.cols, term.rows)
        }
      }
    })
    resizeObserver.observe(el)
  }

  function cleanup(): void {
    recordLifecycle('cleanup', terminalId)
    sizeOwner = null
    resizeObserver?.disconnect()
    resizeObserver = undefined
    attachment?.dispose()
    attachment = undefined
    term?.dispose()
    term = undefined
    fitAddon = undefined
  }

  $effect(() => {
    const el = containerEl
    const id = terminalId
    if (el) {
      setup(el, id)
    }
    return () => {
      cleanup()
    }
  })

  // Two ways attention arrives at an already-mounted, already-selected
  // terminal: the window is focused, or the document becomes visible. Both are
  // deliberate user acts, so both claim. Losing attention does nothing — main
  // owns that decision, and a client that quietly stopped sending resizes on
  // blur is exactly how a reflow-while-unfocused went unheard. `active` and
  // `document` are read inside the handler, so this effect re-registers only
  // on id change.
  $effect(() => {
    const id = terminalId

    function onAttentionChange(): void {
      if (hasUserAttention()) claimPty(id)
    }

    window.addEventListener('focus', onAttentionChange)
    document.addEventListener('visibilitychange', onAttentionChange)

    return () => {
      window.removeEventListener('focus', onAttentionChange)
      document.removeEventListener('visibilitychange', onAttentionChange)
    }
  })

  /**
   * Format dropped paths for whatever is in the foreground, per the provider's
   * `droppedPath` capability — never by provider name.
   */
  function shellEscape(p: string): string {
    if (/^[\w./@:+=-]+$/.test(p)) return p
    return `'${p.replace(/'/g, `'\\''`)}'`
  }

  function formatPaths(paths: string[]): string {
    switch (droppedPath) {
      case 'at-reference': return paths.map((p) => `@${p}`).join(' ')
      case 'newline-list': return paths.join('\n')
      case 'shell-escaped': return paths.map(shellEscape).join(' ')
    }
  }

  function handleDragEnter(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    isDropTarget = true
  }

  function handleDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function handleDragLeave(e: DragEvent): void {
    // Ignore leave events that fire as the cursor crosses child elements.
    const next = e.relatedTarget as Node | null
    if (next && containerEl?.contains(next)) return
    isDropTarget = false
  }

  async function handleDrop(e: DragEvent): Promise<void> {
    isDropTarget = false
    if (!e.dataTransfer?.files.length) return
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    const paths = await Promise.all(files.map(resolveDropPath))
    if (paths.length === 0) return
    await window.api.invoke('pty:write', terminalId, formatPaths(paths))
    term?.focus()
  }

  // Save/restore scroll position on tab visibility changes
  $effect(() => {
    if (!term) return

    if (active) {
      // Becoming visible: fit and restore scroll position.
      // Use rAF so the container has dimensions (no longer display:none).
      requestAnimationFrame(() => {
        if (!term || !fitAddon) return
        // Fit BEFORE claiming: the claim carries the geometry, and this is the
        // moment the container's real size becomes knowable again.
        fitAddon.fit()
        // Selecting a session is attention, so take the size — but only if
        // this window is the focused one. A background window re-showing a
        // tab (a restored layout, a reconnect) must not claim; it still
        // reports its size, and main drops it if someone else owns the PTY.
        if (hasUserAttention()) claimPty(terminalId)
        else window.api.invoke('pty:resize', terminalId, term.cols, term.rows)
        // Restore scroll after fit. If the user was at the bottom when the
        // tab was hidden, follow new content; otherwise stay at the saved line.
        if (wasAtBottom) {
          term.scrollToBottom()
        } else if (savedViewportY !== undefined) {
          term.scrollToLine(savedViewportY)
        }
        // Honor a keyboard "new session" focus request once this terminal is
        // mounted and visible (the session id doubles as the terminal id).
        if (sessionsStore.pendingFocusId() === terminalId) {
          term.focus()
          sessionsStore.consumeFocusRequest(terminalId)
        }
      })
    } else {
      // Becoming hidden: save scroll state. Ownership is main's to move, and
      // the next client to receive the user's attention claims it.
      wasAtBottom = isScrolledToBottom()
      savedViewportY = term.buffer.active.viewportY
    }
  })
</script>

<div
  class="relative h-full w-full overflow-hidden"
  ondragenter={handleDragEnter}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  data-testid="terminal-drop-target"
>
  <div bind:this={containerEl} class="h-full w-full"></div>
  <!-- Main sizes the PTY for whoever claimed it last. When that is not this
       client, this view is fitted to its own container and the terminal is
       not — so say so, rather than letting it read as a rendering bug. -->
  {#if active && sizedElsewhere}
    <div
      class="pointer-events-none absolute right-2 top-2 z-10 rounded bg-zinc-800/90 px-2 py-1 text-[11px] text-zinc-400 shadow"
    >
      Sized by another device
    </div>
  {/if}
  {#if isDropTarget}
    <div
      class="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-sky-400/70 bg-sky-500/10 text-sm font-medium text-sky-200 backdrop-blur-sm"
    >
      Drop file to attach
    </div>
  {/if}
</div>
