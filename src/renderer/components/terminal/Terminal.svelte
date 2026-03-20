<script lang="ts">
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { WebLinksAddon } from '@xterm/addon-web-links'
  import '@xterm/xterm/css/xterm.css'

  interface Props {
    terminalId: string
    active?: boolean
  }

  let { terminalId, active = true }: Props = $props()

  let containerEl: HTMLDivElement | undefined = $state()

  let term: Terminal | undefined
  let fitAddon: FitAddon | undefined
  let cleanupDataListener: (() => void) | undefined
  let cleanupExitListener: (() => void) | undefined
  let resizeObserver: ResizeObserver | undefined

  // Scroll position preservation across tab switches
  let savedViewportY: number | undefined
  let wasAtBottom = true

  function setup(el: HTMLDivElement, id: string): void {
    cleanup()

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
    term.loadAddon(new WebLinksAddon())

    term.open(el)

    // Small delay to ensure the element is laid out before fitting
    requestAnimationFrame(() => {
      fitAddon?.fit()
    })

    // Intercept Shift+Enter to send CSI u sequence (kitty keyboard protocol)
    // so Claude Code treats it as a newline instead of submit
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) {
        window.api.invoke('pty:write', id, '\x1b[13;2u')
        return false
      }
      return true
    })

    // Send keystrokes to the PTY
    term.onData((data: string) => {
      window.api.invoke('pty:write', id, data)
    })

    // Receive data from the PTY
    cleanupDataListener = window.api.on('pty:data', (payload) => {
      if (payload.id === id && term) {
        term.write(payload.data)
      }
    })

    cleanupExitListener = window.api.on('pty:exit', (payload) => {
      if (payload.id === id && term) {
        term.write(`\r\n[Process exited with code ${payload.exitCode}]`)
      }
    })

    // Auto-resize on container size change
    resizeObserver = new ResizeObserver(() => {
      if (fitAddon) {
        fitAddon.fit()
        if (term) {
          window.api.invoke('pty:resize', id, term.cols, term.rows)
        }
      }
    })
    resizeObserver.observe(el)
  }

  function cleanup(): void {
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

  // Save/restore scroll position on tab visibility changes
  $effect(() => {
    if (!term) return

    if (active) {
      // Becoming visible: refit then restore scroll position
      requestAnimationFrame(() => {
        fitAddon?.fit()
        if (term) {
          if (wasAtBottom) {
            term.scrollToBottom()
          } else if (savedViewportY !== undefined) {
            term.scrollToLine(savedViewportY)
          }
        }
      })
    } else {
      // Becoming hidden: save scroll state
      const buf = term.buffer.active
      wasAtBottom = buf.viewportY >= buf.baseY
      savedViewportY = buf.viewportY
    }
  })
</script>

<div
  bind:this={containerEl}
  class="h-full w-full"
></div>
