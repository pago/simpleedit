/**
 * Attaching a view to a live PTY: backlog replay, live output, exit, ownership.
 *
 * Extracted from `Terminal.svelte` so the mobile surface renders the SAME
 * stream rather than a second implementation of it. That matters more here
 * than it looks: Claude presents real TUIs for decisions, and anything that
 * re-derives what the terminal shows will eventually show a confident lie
 * about what is being approved. There is one attachment, and both clients use
 * it.
 *
 * Deliberately not xterm-aware. The caller owns the terminal and how output is
 * written into it — the desktop preserves the user's scroll position, the
 * phone does not need to — so this module only decides WHAT to write and in
 * what order.
 *
 * ── Lifetime ──────────────────────────────────────────────────────────────
 * An attachment belongs to the VIEW, not to the PTY (which outlives every
 * client) and not to the socket (which reconnects under it). `dispose` ends it.
 * A dropped connection is not a disposal: the listener registrations survive
 * one, and `resync` is how the gap it left gets filled — the byte offsets make
 * that exact, so a reconnect replays only what was missed.
 */
import type { PtyClientId } from '../../shared/ipc-types'

export interface PtyAttachOptions {
  /** Called with output to render, already deduplicated and in byte order. */
  write: (data: string) => void
  onExit?: (exitCode: number) => void
  /** Main's word on who sizes this PTY. `null` means nobody does. */
  onOwnerChange?: (owner: PtyClientId | null) => void
  /**
   * Bytes were produced that this view will never see — the disconnect outlasted
   * main's backlog window.
   *
   * The offsets still add up, so nothing is written twice, but an escape
   * sequence was cut somewhere in the missing span and the screen after it can
   * be wrong in ways no later output corrects. Silently papering over that is
   * how a terminal comes to lie.
   */
  onGap?: () => void
}

export interface PtyAttachment {
  /**
   * Re-read main's backlog and write only what this view has not seen.
   *
   * For a reconnect: while the socket was down `pty:data` went nowhere, and
   * the absolute offsets are what make the catch-up exact rather than a
   * duplicated screen or a silent hole.
   */
  resync: () => void
  dispose: () => void
}

export function attachPty(id: string, options: PtyAttachOptions): PtyAttachment {
  /** Absolute byte offset already rendered. The whole dedup rests on this. */
  let written = 0
  /** While false, live chunks are queued so the replay cannot land after them. */
  let replayDone = false
  let disposed = false
  const queued: Array<{ data: string; offset: number }> = []

  function writeDeduped(chunk: { data: string; offset: number }): void {
    const chunkEnd = chunk.offset + chunk.data.length
    if (chunkEnd <= written) return
    // A chunk starting past what we have rendered means the bytes in between
    // are gone for good. `written > 0` distinguishes it from the first write of
    // a terminal whose backlog has already been trimmed, where there is no
    // earlier state to be inconsistent with.
    if (chunk.offset > written && written > 0) options.onGap?.()
    options.write(chunk.data.slice(Math.max(0, written - chunk.offset)))
    written = chunkEnd
  }

  function drainQueue(): void {
    replayDone = true
    for (const chunk of queued) writeDeduped(chunk)
    queued.length = 0
  }

  function loadBacklog(): void {
    replayDone = false
    void window.api
      .invoke('pty:backlog', id)
      .then((backlog) => {
        if (disposed) return
        if (backlog.end > written) writeDeduped({ data: backlog.data, offset: backlog.start })
      })
      .catch(() => {
        /* degrade to live-only output rather than showing nothing */
      })
      .finally(() => {
        if (!disposed) drainQueue()
      })
  }

  const offData = window.api.on('pty:data', (payload) => {
    if (payload.id !== id || disposed) return
    if (!replayDone) {
      queued.push({ data: payload.data, offset: payload.offset })
      return
    }
    writeDeduped(payload)
  })

  const offExit = window.api.on('pty:exit', (payload) => {
    if (payload.id !== id || disposed) return
    // Main drops the owner entry on exit, so a client's belief about it has to
    // go too — a dead terminal must not keep claiming to be sized by somebody.
    options.onOwnerChange?.(null)
    options.onExit?.(payload.exitCode)
  })

  const offOwner = window.api.on('pty:owner-changed', (payload) => {
    if (payload.id !== id || disposed) return
    options.onOwnerChange?.(payload.owner)
  })

  // The PTY spawns before any view mounts, so output emitted in that window —
  // all of it, for a process that dies at spawn — never reaches the listener
  // above. Replay first.
  loadBacklog()

  return {
    resync(): void {
      if (disposed) return
      loadBacklog()
    },
    dispose(): void {
      disposed = true
      offData()
      offExit()
      offOwner()
      queued.length = 0
    },
  }
}
