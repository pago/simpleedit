import { spawn } from 'child_process'
import * as readline from 'readline'
import * as crypto from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { WebContents } from 'electron'
import type {
  Tour,
  TourTopic,
  TourSegment,
  TourStatus,
} from '../shared/ipc-types'
import { getCommitDiff, getStagingDiff, getBranchDiff } from './git-operations'
import { findJsonObjectEnd } from './lib/json-scanner'

const MAX_DIFF_BYTES = 120_000

export function tourKey(worktreePath: string, commitHash: string | null): string {
  return `${worktreePath}:${commitHash ?? 'staging'}`
}

const activeTours = new Map<string, { kill: () => void }>()

function send(wc: WebContents, channel: string, data: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, data)
}

function sendStatus(wc: WebContents, key: string, status: TourStatus, error?: string): void {
  send(wc, 'tour:status', { key, status, error })
}

function sendOverview(wc: WebContents, key: string, overview: string): void {
  send(wc, 'tour:overview', { key, overview })
}

function sendTopic(wc: WebContents, key: string, topic: TourTopic): void {
  send(wc, 'tour:topic', { key, topic })
}

// ── Persistence ──────────────────────────────────────────

function tourCacheDir(): string {
  const dir = join(app.getPath('userData'), 'config', 'tours')
  mkdirSync(dir, { recursive: true })
  return dir
}

function tourCacheFile(worktreePath: string, commitHash: string | null): string {
  const key = tourKey(worktreePath, commitHash)
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
  return join(tourCacheDir(), `${hash}.json`)
}

export function saveTour(worktreePath: string, commitHash: string | null, tour: Tour): void {
  try {
    writeFileSync(tourCacheFile(worktreePath, commitHash), JSON.stringify(tour, null, 2), 'utf-8')
  } catch (err) {
    console.error('[tour] save error:', err)
  }
}

export function loadTour(worktreePath: string, commitHash: string | null): Tour | null {
  try {
    const raw = readFileSync(tourCacheFile(worktreePath, commitHash), 'utf-8')
    return JSON.parse(raw) as Tour
  } catch {
    return null
  }
}

export function saveOverview(worktreePath: string, commitHash: string | null, overview: string): void {
  const existing = loadTour(worktreePath, commitHash)
  if (existing) {
    saveTour(worktreePath, commitHash, { ...existing, overview })
  }
}

// ── Prompt ───────────────────────────────────────────────

function buildTourPrompt(diff: string, commitMessage?: string, overrideOverview?: string, isBranchMode?: boolean): string {
  const body = diff.length > MAX_DIFF_BYTES
    ? diff.slice(0, MAX_DIFF_BYTES) + '\n\n[diff truncated]'
    : diff

  let commitContext: string
  if (isBranchMode && commitMessage) {
    commitContext = `\nThis is a branch tour — all changes on this branch compared to main. The commit messages on this branch are:\n${commitMessage}\n`
  } else if (commitMessage) {
    commitContext = `\nThe commit message is: "${commitMessage}"\n`
  } else {
    commitContext = '\nThese are uncommitted (staged/unstaged) changes.\n'
  }

  const overviewContext = overrideOverview
    ? `\nThe user has described this changeset as follows — use this understanding to guide your groupings and correct any prior misunderstanding:\n"${overrideOverview}"\n`
    : ''

  return `You are a code tour narrator. Analyze the following git diff and produce a guided walkthrough of the changeset, grouped by logical topic or task.
${commitContext}${overviewContext}
Output your response as NDJSON (newline-delimited JSON — one JSON object per line, no other output).

The FIRST line must be an overview object with exactly this field:
- "overview": a concise 2-4 sentence summary of the entire changeset — what was done and why

Each subsequent line must be a topic object with exactly these fields:
- "title": short descriptive title for this logical group of changes (max 80 chars)
- "summary": prose paragraph explaining what this group of changes does and why
- "segments": array of segment objects, each with:
  - "prose": explanation of this specific code change — what it does and why it matters
  - "file": file path as it appears in the diff header (e.g. "src/main/foo.ts")
  - "lineRange": [startLine, endLine] — line numbers in the modified/new version (1-based)

Guidelines:
- Group changes by intent/task, not by file. A single topic may span multiple files.
- A single file may appear in multiple topics if it serves different purposes.
- Explain the "why" — intent, motivation, trade-offs — not just the "what".
- Keep segments focused: one concept per segment, with a tight line range.
- Order topics logically: foundational changes first, then features that build on them.
- Use clear, direct prose. No filler, no marketing language.

CRITICAL: Output ONLY valid JSON objects, one per line. No markdown, no prose, no explanation, no code fences.

<diff>
${body}
</diff>`
}

// ── Validation ───────────────────────────────────────────

function parseRawSegment(obj: unknown): TourSegment | null {
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>

  if (typeof o['prose'] !== 'string' || !o['prose']) return null
  if (typeof o['file'] !== 'string' || !o['file']) return null
  if (!Array.isArray(o['lineRange']) || o['lineRange'].length !== 2) return null
  const [s, e] = o['lineRange'] as [unknown, unknown]
  if (typeof s !== 'number' || typeof e !== 'number') return null

  return {
    prose: o['prose'],
    file: o['file'],
    lineRange: [s, e],
  }
}

function parseRawTopic(obj: unknown): Omit<TourTopic, 'id'> | null {
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>

  if (typeof o['title'] !== 'string' || !o['title']) return null
  if (typeof o['summary'] !== 'string' || !o['summary']) return null
  if (!Array.isArray(o['segments']) || o['segments'].length === 0) return null

  const segments: TourSegment[] = []
  for (const seg of o['segments']) {
    const parsed = parseRawSegment(seg)
    if (parsed) segments.push(parsed)
  }
  if (segments.length === 0) return null

  return {
    title: o['title'],
    summary: o['summary'],
    segments,
  }
}

// ── Tour generation ──────────────────────────────────────

export async function startTour(
  worktreePath: string,
  commitHash: string | null,
  webContents: WebContents,
  overrideOverview?: string
): Promise<void> {
  const key = tourKey(worktreePath, commitHash)

  cancelTour(worktreePath, commitHash)
  sendStatus(webContents, key, 'running')

  const isBranchMode = commitHash === 'branch'

  let diff: string
  try {
    if (isBranchMode) {
      diff = await getBranchDiff(worktreePath)
    } else if (commitHash) {
      diff = await getCommitDiff(worktreePath, commitHash)
    } else {
      diff = await getStagingDiff(worktreePath)
    }
  } catch (err: unknown) {
    sendStatus(webContents, key, 'error', String(err))
    return
  }

  if (!diff.trim()) {
    sendStatus(webContents, key, 'done')
    return
  }

  // Retrieve commit message(s) for context if available
  let commitMessage: string | undefined
  if (isBranchMode) {
    try {
      const { simpleGit } = await import('simple-git')
      const git = simpleGit(worktreePath)
      const mergeBase = (await git.raw(['merge-base', 'main', 'HEAD'])).trim()
      const logResult = await git.log({ from: mergeBase, to: 'HEAD' })
      commitMessage = logResult.all.map((c) => c.message.split('\n')[0]).join('\n')
    } catch { /* no messages available */ }
  } else if (commitHash) {
    try {
      const { simpleGit } = await import('simple-git')
      const git = simpleGit(worktreePath)
      const logResult = await git.log({ maxCount: 1, from: commitHash, to: commitHash })
      commitMessage = logResult.latest?.message
    } catch { /* no message available */ }
  }

  const prompt = buildTourPrompt(diff, commitMessage, overrideOverview, isBranchMode)

  const proc = spawn('claude', [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ], {
    cwd: worktreePath,
    env: process.env as Record<string, string>,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  proc.stdin.write(prompt, 'utf8')
  proc.stdin.end()

  let topicCounter = 0
  const accumulatedTour: Tour = { overview: '', topics: [] }

  activeTours.set(key, {
    kill: () => {
      try { proc.kill() } catch { /* already dead */ }
    },
  })

  let lastSnapshotText = ''
  let scanPos = 0

  function processTextSnapshot(text: string): void {
    if (!text.startsWith(lastSnapshotText)) {
      lastSnapshotText += text
    } else {
      lastSnapshotText = text
    }
    scanForObjects()
  }

  function scanForObjects(): void {
    let pos = scanPos
    while (pos < lastSnapshotText.length) {
      const start = lastSnapshotText.indexOf('{', pos)
      if (start === -1) break
      const end = findJsonObjectEnd(lastSnapshotText, start)
      if (end === -1) break
      const json = lastSnapshotText.slice(start, end + 1)
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>

        if (typeof parsed['overview'] === 'string') {
          accumulatedTour.overview = parsed['overview']
          sendOverview(webContents, key, parsed['overview'])
        } else {
          const topic = parseRawTopic(parsed)
          if (topic) {
            const full: TourTopic = { ...topic, id: `${key}:${topicCounter++}` }
            accumulatedTour.topics.push(full)
            sendTopic(webContents, key, full)
          }
        }
      } catch { /* not valid JSON */ }
      scanPos = end + 1
      pos = scanPos
    }
  }

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      if (trimmed) console.log('[tour] non-JSON stdout:', trimmed.slice(0, 120))
      return
    }
    try {
      const ev = JSON.parse(trimmed) as Record<string, unknown>
      if (ev['type'] === 'stream_event') {
        const inner = ev['event'] as Record<string, unknown> | undefined
        if (inner?.['type'] === 'content_block_delta') {
          const delta = inner['delta'] as Record<string, unknown> | undefined
          if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text']) {
            processTextSnapshot(delta['text'] as string)
          }
        }
      }

      if (ev['type'] === 'result' && typeof ev['result'] === 'string') {
        processTextSnapshot(ev['result'] as string)
      }
    } catch (err) {
      console.log('[tour] JSON parse error:', err, '| line preview:', trimmed.slice(0, 80))
    }
  })

  let stderrBuf = ''
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })

  proc.on('close', (code) => {
    rl.close()
    activeTours.delete(key)
    console.log('[tour] process exited with code', code, '| topics emitted:', topicCounter)
    if (stderrBuf) console.error('[tour] stderr:', stderrBuf.slice(0, 500))

    if (code === 0 && accumulatedTour.topics.length > 0) {
      saveTour(worktreePath, commitHash, accumulatedTour)
    }

    sendStatus(webContents, key, code === 0 ? 'done' : 'error')
  })

  proc.on('error', (err: Error) => {
    rl.close()
    activeTours.delete(key)
    console.error('[tour] spawn error:', err.message)
    sendStatus(webContents, key, 'error', err.message)
  })
}

export function cancelTour(worktreePath: string, commitHash: string | null): void {
  const key = tourKey(worktreePath, commitHash)
  activeTours.get(key)?.kill()
  activeTours.delete(key)
}

export function cancelAllTours(): void {
  for (const { kill } of activeTours.values()) kill()
  activeTours.clear()
}
