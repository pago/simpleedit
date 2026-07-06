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

  return `You are a senior code reviewer. Review the following git diff and report only high-signal findings as NDJSON (newline-delimited JSON — one JSON object per line, no other output whatsoever).

Governing principle: PRECISION OVER RECALL. Three real, well-evidenced findings beat a dozen shaky ones. If the diff is clean it is correct to report very few findings, or only praise — never pad the review.

Look for problems in this priority order:
1. Correctness & soundness — bugs, logic errors, off-by-one, unhandled null/undefined, missed edge cases, race conditions, data-integrity hazards, and error handling (swallowed errors, unsafe fallbacks, missing failure paths).
2. Design & placement — a responsibility in the wrong layer, a leaky abstraction, or coupling that will be costly to live with — but only when you can name the concrete problem and a better home for the code.
3. Genuine improvements — a materially better approach, not a preference.

Before emitting any finding, try to REFUTE it and drop it unless it survives:
- Is the code path actually reachable, or is the input already guarded/validated upstream?
- Is it introduced by THIS diff, on lines that changed? Never report pre-existing issues or unmodified lines.
- Is the change intentional and part of the diff's evident purpose?
- Would a linter, formatter, type-checker, or compiler already catch it? If so, drop it.
- Is it merely style or preference? Drop it.
Only emit findings you are confident are both real and consequential. When in doubt, cut it.

Each finding MUST have exactly these fields:
- "label": one of "praise" | "nitpick" | "suggestion" | "issue" | "question" | "thought" | "chore"
- "decoration": (optional) "blocking" | "non-blocking" | "if-minor" — omit if not applicable
- "file": the file path as it appears in the diff header (e.g. "src/main/foo.ts")
- "lineRange": [startLine, endLine] — 1-based line numbers in the modified/new file
- "title": short one-line summary, max 80 characters
- "body": the specific evidence (name the exact variable/function and what goes wrong) AND a concrete, actionable fix — never a vague "consider improving X".

Label meanings follow Conventional Comments (https://conventionalcomments.org/):
- issue: a real bug, logic error, or security/data problem — add "blocking" for must-fix items
- suggestion: a concrete improvement, usually non-blocking
- question: a genuine concern worth clarifying
- praise: something notably well done — use sparingly, only when real
- nitpick / thought / chore: minor — emit ONLY when genuinely worth the reader's attention; prefer to omit trivia rather than manufacture it

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
