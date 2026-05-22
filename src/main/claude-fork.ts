/**
 * Main-process orchestration for "Fork into worktree" (issue #87).
 *
 * Flow:
 *   1. Copy the source session's JSONL (and any subagent subdir) into the
 *      target worktree's Claude project dir.
 *   2. Spawn `claude --session-id <forkUuid> --resume <srcSessionId>
 *      --fork-session` in the target cwd.
 *   3. Emit `claude:session-id` for the new tab synchronously — the renderer
 *      already knows forkUuid since we passed it in via IPC.
 *   4. On failure: unlink the copied JSONL iff Claude never touched it (size
 *      unchanged), and the subagent subdir iff no descendant grew. See
 *      critic's PR4 pre-audit §1 for why this beats an mtime-based guard.
 *
 * On success the picker UI transitions its placeholder tab to a live Terminal
 * on first `pty:data`. On failure the picker shows an error state.
 */
import { promises as fs, existsSync, statSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import type { ClaudeForkOptions } from '../shared/ipc-types'
import { claudeProjectsDir } from './claude-paths'
import { spawnForkedClaudeTerminal } from './pty'

/**
 * Walk `dir` recursively, returning a list of `{ relPath, size }` entries for
 * every regular file. Used to baseline a directory so we can tell whether
 * Claude wrote anything new into it after our copy.
 *
 * Returns an empty list if `dir` doesn't exist — callers treat that as "we
 * created nothing there, so there's nothing to clean up".
 */
async function snapshotDirSizes(dir: string): Promise<Array<{ relPath: string; size: number }>> {
  if (!existsSync(dir)) return []
  const out: Array<{ relPath: string; size: number }> = []
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const e of entries) {
      const full = join(current, e.name)
      const rel = prefix ? join(prefix, e.name) : e.name
      if (e.isDirectory()) {
        await walk(full, rel)
      } else if (e.isFile()) {
        const st = await fs.stat(full)
        out.push({ relPath: rel, size: st.size })
      }
    }
  }
  await walk(dir, '')
  return out
}

/**
 * Returns true iff every file in `baseline` still exists at exactly the
 * recorded size (i.e. Claude never appended). Treats new files as "Claude
 * grew the dir" too.
 */
async function dirUnchangedSince(
  dir: string,
  baseline: Array<{ relPath: string; size: number }>,
): Promise<boolean> {
  const current = await snapshotDirSizes(dir)
  if (current.length !== baseline.length) return false
  const map = new Map(current.map((e) => [e.relPath, e.size]))
  for (const b of baseline) {
    if (map.get(b.relPath) !== b.size) return false
  }
  return true
}

/**
 * Perform the fork. Emits `claude:fork-result` with the outcome.
 *
 * This function does NOT throw on user-visible error conditions; it catches
 * them and forwards them via the result IPC so the renderer can show a
 * readable error in the placeholder tab.
 */
export async function performFork(
  options: ClaudeForkOptions,
  webContents: WebContents,
): Promise<void> {
  const {
    sourceSessionId,
    sourceWorktreePath,
    targetWorktreePath,
    forkUuid,
    placeholderTabId,
  } = options

  // Defensive: catch the silent-no-op footgun where forkUuid === sourceSessionId.
  // The renderer pre-mints forkUuid via crypto.randomUUID() so this is a
  // programmer error if it ever fires.
  if (forkUuid === sourceSessionId) {
    sendResult(webContents, placeholderTabId, {
      ok: false,
      error: 'fork uuid collision (would silently append to source instead of forking)',
    })
    return
  }

  let copiedJsonl: string | null = null
  let copiedSubagentDir: string | null = null
  let postCopySize = 0
  let subagentBaseline: Array<{ relPath: string; size: number }> = []

  try {
    const srcDir = claudeProjectsDir(sourceWorktreePath)
    const tgtDir = claudeProjectsDir(targetWorktreePath)
    const srcJsonl = join(srcDir, `${sourceSessionId}.jsonl`)
    const tgtJsonl = join(tgtDir, `${sourceSessionId}.jsonl`)
    const srcSubagentDir = join(srcDir, sourceSessionId)
    const tgtSubagentDir = join(tgtDir, sourceSessionId)

    if (!existsSync(srcJsonl)) {
      sendResult(webContents, placeholderTabId, {
        ok: false,
        error: `source session transcript not found (${sourceSessionId}.jsonl)`,
      })
      return
    }

    // Ensure target project dir exists (idempotent).
    await fs.mkdir(tgtDir, { recursive: true })

    // Copy the JSONL. Overwrite is fine — see critic's §3 of the audit: even
    // forking the same source twice into the same target works correctly.
    await fs.copyFile(srcJsonl, tgtJsonl)
    copiedJsonl = tgtJsonl
    postCopySize = (await fs.stat(tgtJsonl)).size

    // Conditionally copy the subagent subdir if the source has one. Skipping
    // memory/ is deliberate: that dir is project-scoped, not session-scoped,
    // and copying it would pollute the target worktree's existing auto-memory.
    if (existsSync(srcSubagentDir) && statSync(srcSubagentDir).isDirectory()) {
      await fs.cp(srcSubagentDir, tgtSubagentDir, { recursive: true, force: true })
      copiedSubagentDir = tgtSubagentDir
      subagentBaseline = await snapshotDirSizes(tgtSubagentDir)
    }

    // Spawn the forked Claude PTY. spawnForkedClaudeTerminal validates that
    // forkUuid !== sourceSessionId; we've already checked but the redundancy
    // is cheap.
    spawnForkedClaudeTerminal(
      {
        placeholderTabId,
        sourceSessionId,
        targetWorktreePath,
        forkUuid,
      },
      webContents,
    )

    // Tell the renderer the fork's session id synchronously — we already
    // know it (we generated it), no need to scrape the init line.
    if (!webContents.isDestroyed()) {
      webContents.send('claude:session-id', {
        terminalId: placeholderTabId,
        sessionId: forkUuid,
      })
    }

    sendResult(webContents, placeholderTabId, { ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Attempt to clean up anything we created if Claude never wrote to it.
    await safeRollback({ copiedJsonl, postCopySize, copiedSubagentDir, subagentBaseline })
    sendResult(webContents, placeholderTabId, {
      ok: false,
      error: `fork failed: ${message}`,
    })
  }
}

/**
 * Unlink artifacts that we wrote IFF Claude hasn't touched them since.
 * Uses size as the freshness signal (per critic's §1 — beats mtime on FAT/NFS
 * with coarse clocks and clock-skew edge cases).
 *
 * Best-effort: never throws. A leftover file is annoying but not catastrophic.
 */
async function safeRollback(args: {
  copiedJsonl: string | null
  postCopySize: number
  copiedSubagentDir: string | null
  subagentBaseline: Array<{ relPath: string; size: number }>
}): Promise<void> {
  const { copiedJsonl, postCopySize, copiedSubagentDir, subagentBaseline } = args

  if (copiedJsonl) {
    try {
      const currentSize = (await fs.stat(copiedJsonl)).size
      if (currentSize === postCopySize) {
        await fs.unlink(copiedJsonl)
      }
    } catch { /* file may have moved/disappeared; ignore */ }
  }

  if (copiedSubagentDir) {
    try {
      if (await dirUnchangedSince(copiedSubagentDir, subagentBaseline)) {
        await fs.rm(copiedSubagentDir, { recursive: true, force: true })
      }
    } catch { /* ignore */ }
  }
}

function sendResult(
  webContents: WebContents,
  placeholderTabId: string,
  payload: { ok: true } | { ok: false; error: string },
): void {
  if (webContents.isDestroyed()) return
  if (payload.ok) {
    webContents.send('claude:fork-result', { placeholderTabId, ok: true })
  } else {
    webContents.send('claude:fork-result', {
      placeholderTabId,
      ok: false,
      error: payload.error,
    })
  }
}
