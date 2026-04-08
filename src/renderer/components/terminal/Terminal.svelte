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

    // Auto-resize on container size change.
    // Guard against zero dimensions: ResizeObserver fires when a tab is hidden
    // (display:none), which would cause fitAddon to calculate 0 columns and
    // corrupt the PTY's line wrapping.
    resizeObserver = new ResizeObserver(() => {
      if (fitAddon && el.offsetWidth > 0 && el.offsetHeight > 0) {
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
      // Becoming visible: fit first, then restore scroll in a second rAF so
      // xterm.js finishes its own post-resize scroll before we override it.
      requestAnimationFrame(() => {
        fitAddon?.fit()
        requestAnimationFrame(() => {
          if (term) {
            if (wasAtBottom) {
              term.scrollToBottom()
            } else if (savedViewportY !== undefined) {
              term.scrollToLine(savedViewportY)
            }
          }
        })
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
