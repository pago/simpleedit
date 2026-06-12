<script lang="ts">
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { WebLinksAddon } from '@xterm/addon-web-links'
  import '@xterm/xterm/css/xterm.css'

  interface Props {
    terminalId: string
    active?: boolean
    isClaude?: boolean
    ontitlechange?: (title: string) => void
  }

  let { terminalId, active = true, isClaude = false, ontitlechange }: Props = $props()

  let containerEl: HTMLDivElement | undefined = $state()
  let isDropTarget = $state(false)

  let term: Terminal | undefined
  let fitAddon: FitAddon | undefined
  let cleanupDataListener: (() => void) | undefined
  let cleanupExitListener: (() => void) | undefined
  let resizeObserver: ResizeObserver | undefined

  // Scroll position preservation across tab switches
  let savedViewportY: number | undefined
  let wasAtBottom = true

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

    // Intercept Shift+Enter so Claude Code treats it as a newline instead of submit.
    // For Claude terminals: send CSI u sequence (kitty keyboard protocol).
    // For regular shells: just let Enter through normally (Shift has no meaning).
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.shiftKey) {
        if (e.type === 'keydown' && isClaude) {
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

    // The PTY spawns before this component mounts, so output emitted in that
    // window (all of it, for a process that crashes at spawn) never reaches
    // this listener. Replay main's backlog first; `written` tracks the
    // absolute byte offset already rendered so live chunks that overlap the
    // replay are deduped. Live chunks arriving before the replay resolves are
    // queued to keep byte order.
    let written = 0
    let replayDone = false
    const queued: Array<{ data: string; offset: number }> = []

    function writeDeduped(chunk: { data: string; offset: number }): void {
      const chunkEnd = chunk.offset + chunk.data.length
      if (chunkEnd <= written) return
      writeChunk(chunk.data.slice(Math.max(0, written - chunk.offset)))
      written = chunkEnd
    }

    cleanupDataListener = window.api.on('pty:data', (payload) => {
      if (payload.id !== id || !term) return
      if (!replayDone) {
        queued.push({ data: payload.data, offset: payload.offset })
        return
      }
      writeDeduped(payload)
    })

    void window.api
      .invoke('pty:backlog', id)
      .then((b) => {
        if (term && b.end > written) {
          writeDeduped({ data: b.data, offset: b.start })
        }
      })
      .catch(() => { /* degrade to live-only output */ })
      .finally(() => {
        replayDone = true
        for (const chunk of queued) writeDeduped(chunk)
        queued.length = 0
      })

    cleanupExitListener = window.api.on('pty:exit', (payload) => {
      if (payload.id === id && term) {
        term.write(`\r\n[Process exited with code ${payload.exitCode}]`)
      }
    })

    // Auto-resize on container size change.
    // Guard against zero dimensions: ResizeObserver fires when a tab is hidden
    // (display:none), which would cause fitAddon to calculate 0 columns and
    // corrupt the PTY's line wrapping.
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
    resizeObserver?.disconnect()
    resizeObserver = undefined
    cleanupDataListener?.()
    cleanupDataListener = undefined
    cleanupExitListener?.()
    cleanupExitListener = undefined
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

  /**
   * Format dropped paths for the foreground process. Claude Code parses paths
   * via regex and accepts newline-separated lists; a regular shell would
   * submit on a literal newline, so we space-separate (and quote spaces) there.
   */
  function shellEscape(p: string): string {
    if (/^[\w./@:+=-]+$/.test(p)) return p
    return `'${p.replace(/'/g, `'\\''`)}'`
  }

  function formatPaths(paths: string[]): string {
    if (isClaude) return paths.join('\n')
    return paths.map(shellEscape).join(' ')
  }

  async function resolveDropPath(file: File): Promise<string> {
    const path = window.api.getPathForFile(file)
    if (path) return path
    const bytes = new Uint8Array(await file.arrayBuffer())
    return window.api.invoke('app:save-dropped-blob', file.name || 'paste', bytes)
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
        fitAddon.fit()
        if (term) {
          window.api.invoke('pty:resize', terminalId, term.cols, term.rows)
        }
        // Restore scroll after fit. If the user was at the bottom when the
        // tab was hidden, follow new content; otherwise stay at the saved line.
        if (wasAtBottom) {
          term.scrollToBottom()
        } else if (savedViewportY !== undefined) {
          term.scrollToLine(savedViewportY)
        }
      })
    } else {
      // Becoming hidden: save scroll state
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
  {#if isDropTarget}
    <div
      class="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-sky-400/70 bg-sky-500/10 text-sm font-medium text-sky-200 backdrop-blur-sm"
    >
      Drop file to attach
    </div>
  {/if}
</div>
