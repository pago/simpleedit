/**
 * The Review bounded task: gather the diff, build the reviewer prompt, and
 * validate each streamed finding. Lifted verbatim from the former inline
 * `review.ts` so the cloud path stays behaviour-identical; being self-contained
 * (the diff is embedded in the prompt) it also runs under the harness-free
 * DirectRunner without file access.
 */
import type {
  ReviewFinding,
  ConventionalCommentLabel,
  ReviewFindingDecoration,
} from '../../shared/ipc-types'
import { getCommitDiff, getStagingDiff } from '../git-operations'
import type { Task } from '../agent-tasks/orchestrator'

const MAX_DIFF_BYTES = 120_000

export interface ReviewInput {
  worktreePath: string
  commitHash: string | null
}

export interface ReviewContext {
  diff: string
}

/** A validated finding minus the caller-assigned `id`. */
export type RawReviewFinding = Omit<ReviewFinding, 'id'>

function buildReviewPrompt(diff: string): string {
  const body =
    diff.length > MAX_DIFF_BYTES ? diff.slice(0, MAX_DIFF_BYTES) + '\n\n[diff truncated]' : diff

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

function parseRawFinding(obj: unknown): RawReviewFinding | null {
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

export const reviewTask: Task<ReviewInput, ReviewContext, RawReviewFinding> = {
  name: 'review',
  async buildContext({ worktreePath, commitHash }) {
    const diff = commitHash
      ? await getCommitDiff(worktreePath, commitHash)
      : await getStagingDiff(worktreePath)
    return { diff }
  },
  buildPrompt({ diff }) {
    return { system: '', user: buildReviewPrompt(diff) }
  },
  parse: parseRawFinding,
}
