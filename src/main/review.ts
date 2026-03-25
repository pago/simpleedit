import { spawn } from 'child_process'
import * as readline from 'readline'
import type { WebContents } from 'electron'
import type {
  ReviewFinding,
  ReviewStatus,
  ConventionalCommentLabel,
  ReviewFindingDecoration,
} from '../shared/ipc-types'
import { getCommitDiff, getStagingDiff } from './git-operations'
import { findJsonObjectEnd } from './lib/json-scanner'

const MAX_DIFF_BYTES = 120_000

export function reviewKey(worktreePath: string, commitHash: string | null): string {
  return `${worktreePath}:${commitHash ?? 'staging'}`
}

const activeReviews = new Map<string, { kill: () => void }>()

function send(wc: WebContents, channel: string, data: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, data)
}

function sendStatus(wc: WebContents, key: string, status: ReviewStatus, error?: string): void {
  send(wc, 'review:status', { key, status, error })
}

function sendFinding(wc: WebContents, key: string, finding: ReviewFinding): void {
  send(wc, 'review:finding', { key, finding })
}

function buildPrompt(diff: string): string {
  const body = diff.length > MAX_DIFF_BYTES
    ? diff.slice(0, MAX_DIFF_BYTES) + '\n\n[diff truncated]'
    : diff

  return `You are a code reviewer. Analyze the following git diff and output your findings as NDJSON (newline-delimited JSON — one JSON object per line, no other output whatsoever).

Each finding must have exactly these fields:
- "label": one of "praise" | "nitpick" | "suggestion" | "issue" | "question" | "thought" | "chore"
- "decoration": (optional) one of "blocking" | "non-blocking" | "if-minor" — omit if not applicable
- "file": the file path as it appears in the diff header (e.g. "src/main/foo.ts")
- "lineRange": [startLine, endLine] — line numbers in the modified/new version of the file (1-based)
- "title": short one-line summary, max 80 characters
- "body": detailed explanation with a concrete, actionable suggestion

Label meanings follow Conventional Comments (https://conventionalcomments.org/):
- praise: something done well, no action needed
- nitpick: minor style/preference issue, not blocking
- suggestion: improvement idea, usually non-blocking
- issue: actual bug, logic error, or security problem — add "blocking" decoration for must-fix items
- question: needs clarification or raises a concern worth discussing
- thought: observation that may not require action
- chore: required but mechanical cleanup

Be specific: reference exact variable names, function names, and line numbers. Prefer fewer high-signal findings over many low-signal ones. Skip obvious style issues unless they indicate a deeper problem.

CRITICAL: Output ONLY valid JSON objects, one per line. No markdown, no prose, no explanation, no code fences.

<diff>
${body}
</diff>`
}


const VALID_LABELS = new Set<string>([
  'praise', 'nitpick', 'suggestion', 'issue', 'question', 'thought', 'chore',
])
const VALID_DECORATIONS = new Set<string>(['blocking', 'non-blocking', 'if-minor'])

function parseRawFinding(obj: unknown): Omit<ReviewFinding, 'id'> | null {
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>

  if (!VALID_LABELS.has(String(o['label']))) return null
  if (typeof o['file'] !== 'string' || !o['file']) return null
  if (!Array.isArray(o['lineRange']) || o['lineRange'].length !== 2) return null
  const [s, e] = o['lineRange'] as [unknown, unknown]
  if (typeof s !== 'number' || typeof e !== 'number') return null
  if (typeof o['title'] !== 'string' || !o['title']) return null
  if (typeof o['body'] !== 'string' || !o['body']) return null

  const dec = String(o['decoration'])
  return {
    label: o['label'] as ConventionalCommentLabel,
    decoration: VALID_DECORATIONS.has(dec) ? (o['decoration'] as ReviewFindingDecoration) : undefined,
    file: o['file'],
    lineRange: [s, e],
    title: o['title'],
    body: o['body'],
  }
}

export async function startReview(
  worktreePath: string,
  commitHash: string | null,
  webContents: WebContents
): Promise<void> {
  const key = reviewKey(worktreePath, commitHash)

  // Cancel any in-progress review for this target before starting fresh
  cancelReview(worktreePath, commitHash)

  sendStatus(webContents, key, 'running')

  let diff: string
  try {
    diff = commitHash
      ? await getCommitDiff(worktreePath, commitHash)
      : await getStagingDiff(worktreePath)
  } catch (err: unknown) {
    sendStatus(webContents, key, 'error', String(err))
    return
  }

  if (!diff.trim()) {
    sendStatus(webContents, key, 'done')
    return
  }

  const prompt = buildPrompt(diff)

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

  let counter = 0

  activeReviews.set(key, {
    kill: () => {
      try { proc.kill() } catch { /* already dead */ }
    },
  })

  // Accumulate assistant text and progressively extract complete JSON findings.
  // Each stream-json event line contains a growing snapshot of the assistant's
  // response so far (not a delta), so we diff against the last snapshot.
  let lastSnapshotText = ''
  let scanPos = 0 // how far into lastSnapshotText we've already scanned

  function processTextSnapshot(text: string): void {
    if (!text.startsWith(lastSnapshotText)) {
      // Delta mode: text is only the new portion
      lastSnapshotText += text
    } else {
      lastSnapshotText = text
    }
    scanForFindings()
  }

  function scanForFindings(): void {
    let pos = scanPos
    while (pos < lastSnapshotText.length) {
      const start = lastSnapshotText.indexOf('{', pos)
      if (start === -1) break
      const end = findJsonObjectEnd(lastSnapshotText, start)
      if (end === -1) break // incomplete — wait for more text
      const json = lastSnapshotText.slice(start, end + 1)
      try {
        const raw = parseRawFinding(JSON.parse(json) as unknown)
        if (raw) {
          const finding: ReviewFinding = { ...raw, id: `${key}:${counter++}` }
          sendFinding(webContents, key, finding)
        }
      } catch { /* not a finding */ }
      scanPos = end + 1
      pos = scanPos
    }
  }

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      if (trimmed) console.log('[review] non-JSON stdout:', trimmed.slice(0, 120))
      return
    }
    try {
      const ev = JSON.parse(trimmed) as Record<string, unknown>
      // Stream text deltas as Claude generates them
      if (ev['type'] === 'stream_event') {
        const inner = ev['event'] as Record<string, unknown> | undefined
        if (inner?.['type'] === 'content_block_delta') {
          const delta = inner['delta'] as Record<string, unknown> | undefined
          if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text']) {
            processTextSnapshot(delta['text'] as string)
            if (counter > 0) console.log('[review] findings so far:', counter)
          }
        }
      }

      // Final result event — catches anything not yet scanned
      if (ev['type'] === 'result' && typeof ev['result'] === 'string') {
        processTextSnapshot(ev['result'] as string)
      }
    } catch (err) {
      console.log('[review] JSON parse error:', err, '| line preview:', trimmed.slice(0, 80))
    }
  })

  // Capture stderr so silent failures are visible in the main-process console
  let stderrBuf = ''
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })

  proc.on('close', (code) => {
    rl.close()
    activeReviews.delete(key)
    console.log('[review] process exited with code', code, '| total findings emitted:', counter)
    if (stderrBuf) console.error('[review] stderr:', stderrBuf.slice(0, 500))
    sendStatus(webContents, key, code === 0 ? 'done' : 'error')
  })

  proc.on('error', (err: Error) => {
    rl.close()
    activeReviews.delete(key)
    console.error('[review] spawn error:', err.message)
    sendStatus(webContents, key, 'error', err.message)
  })
}

export function cancelReview(worktreePath: string, commitHash: string | null): void {
  const key = reviewKey(worktreePath, commitHash)
  activeReviews.get(key)?.kill()
  activeReviews.delete(key)
}

export function cancelAllReviews(): void {
  for (const { kill } of activeReviews.values()) kill()
  activeReviews.clear()
}
