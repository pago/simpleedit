/**
 * The Tour bounded task: gather the diff (+ commit message context), build the
 * narrator prompt, and validate each streamed output object. Lifted verbatim
 * from the former inline `tour.ts` so the cloud path stays behaviour-identical;
 * being self-contained (the diff is embedded in the prompt) it also runs under
 * the harness-free DirectRunner without file access.
 *
 * Tour emits two kinds of object on one NDJSON stream — a single overview
 * object followed by topic objects — so `parse` yields a discriminated
 * `TourItem` and the caller (`tour.ts`) dispatches each to `tour:overview` /
 * `tour:topic`. This keeps the single-stream `runTask`/`Runner` unchanged.
 */
import type { TourTopic, TourSegment } from '../../shared/ipc-types'
import { getCommitDiff, getStagingDiff, getBranchDiff } from '../git-operations'
import type { Task } from '../agent-tasks/orchestrator'

const MAX_DIFF_BYTES = 120_000

export interface TourInput {
  worktreePath: string
  commitHash: string | null
  overrideOverview?: string
}

export interface TourContext {
  diff: string
  commitMessage?: string
  overrideOverview?: string
  isBranchMode: boolean
}

/** A validated topic minus the caller-assigned `id`. */
export type RawTourTopic = Omit<TourTopic, 'id'>

/**
 * One item off the single NDJSON stream: either the overview line or a topic.
 * The caller assigns topic ids and routes each to its `tour:*` IPC channel.
 */
export type TourItem =
  | { kind: 'overview'; overview: string }
  | { kind: 'topic'; topic: RawTourTopic }

function buildTourPrompt(
  diff: string,
  commitMessage?: string,
  overrideOverview?: string,
  isBranchMode?: boolean
): string {
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

function parseRawTopic(obj: unknown): RawTourTopic | null {
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

function parseTourItem(obj: unknown): TourItem | null {
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>

  // The overview line is discriminated by its string `overview` field; every
  // other object is treated as a topic (verbatim from the former tour.ts).
  if (typeof o['overview'] === 'string') {
    return { kind: 'overview', overview: o['overview'] }
  }
  const topic = parseRawTopic(o)
  return topic ? { kind: 'topic', topic } : null
}

export const tourTask: Task<TourInput, TourContext, TourItem> = {
  name: 'tour',
  async buildContext({ worktreePath, commitHash, overrideOverview }) {
    const isBranchMode = commitHash === 'branch'

    let diff: string
    if (isBranchMode) {
      diff = await getBranchDiff(worktreePath)
    } else if (commitHash) {
      diff = await getCommitDiff(worktreePath, commitHash)
    } else {
      diff = await getStagingDiff(worktreePath)
    }

    // Retrieve commit message(s) for context if available. Failures here are
    // non-fatal — the tour still runs without message context (verbatim from
    // the former tour.ts, where these were swallowed independently of the diff).
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

    return { diff, commitMessage, overrideOverview, isBranchMode }
  },
  buildPrompt({ diff, commitMessage, overrideOverview, isBranchMode }) {
    return {
      system: '',
      user: buildTourPrompt(diff, commitMessage, overrideOverview, isBranchMode),
    }
  },
  parse: parseTourItem,
}
