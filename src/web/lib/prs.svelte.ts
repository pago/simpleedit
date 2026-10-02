/**
 * The two pieces of Screen PRs state the shared renderer store does not own.
 *
 * Everything else — buckets, sorting, drafts, deep-review progress, the submit
 * call — is `stores/screenprs.svelte.ts`, reused verbatim. This module only
 * covers what is true of the phone and not of the desk:
 *
 *  1. **The diff is fetched, not pushed.** Board cards reach a socket client
 *     with `diff` emptied (see `main/screenprs.ts`), so a PR's diff arrives when
 *     it is opened. Cached per head SHA: navigating back into a PR is instant,
 *     and a PR whose head moved refetches rather than showing yesterday's code.
 *  2. **A verdict has to be chosen.** `emptyReviewDraft()` starts at `approve`,
 *     which is right at a desk and wrong under a thumb — it would make Approve
 *     the outcome of *not deciding*. Submit stays disabled until the verdict is
 *     tapped.
 *  3. **An unknown outcome latches.** GitHub has no idempotency key for
 *     reviews, so a submit whose result never came back must not re-arm reading
 *     like a fresh one — the second tap is how you get two reviews.
 *
 * All three live for the page: a reconnect leaves them alone (they are
 * client-side and nothing about them is stale), and a reload drops them.
 */

/** How a submit ended, when it did not simply succeed. */
export type SubmitOutcome =
  /** Main answered: GitHub refused it. Nothing was posted. */
  | { kind: 'refused'; message: string }
  /** The call provably never left the device. Nothing was posted. */
  | { kind: 'not-sent'; message: string }
  /** It was sent and never answered. It may or may not have posted. */
  | { kind: 'unknown'; message: string }

/** What a tap on a diff line hands to the comment sheet. */
export interface CommentTarget {
  file: string
  line: string
  /** `LEFT` for a deleted row, whose `line` counts in the old file. */
  side: 'LEFT' | 'RIGHT'
  /** The line as it reads in the diff, shown once the keyboard covers the code. */
  snippet: string
}

const key = (url: string, headSha: string): string => `${url}@${headSha}`

const diffs = new Map<string, string>()
/** One fetch per PR at a time — a double tap must not run `gh pr diff` twice. */
const inFlight = new Map<string, Promise<string>>()

/** The diff if it is already here, else undefined. Never triggers a fetch. */
export function cachedDiff(url: string, headSha: string): string | undefined {
  return diffs.get(key(url, headSha))
}

/** The PR's diff, fetched once per head SHA. Rejects if `gh` does. */
export function fetchDiff(url: string, headSha: string): Promise<string> {
  const k = key(url, headSha)
  const have = diffs.get(k)
  if (have !== undefined) return Promise.resolve(have)
  const running = inFlight.get(k)
  if (running) return running
  const request = window.api
    .invoke('screenprs:pr-diff', { url, headSha })
    .then((diff) => {
      diffs.set(k, diff)
      return diff
    })
    .finally(() => {
      // Dropped either way: a failure must be retryable, and a success is in
      // `diffs` now.
      inFlight.delete(k)
    })
  inFlight.set(k, request)
  return request
}

let chosen = $state<Set<string>>(new Set())

/** Which PRs have had their verdict explicitly chosen on this phone. */
export const verdictChoice = {
  made: (url: string): boolean => chosen.has(url),
  make(url: string): void {
    chosen = new Set(chosen).add(url)
  },
  /** Forget the choice — after a submit, so a follow-up review re-decides. */
  reset(url: string): void {
    const next = new Set(chosen)
    next.delete(url)
    chosen = next
  },
}

let unknown = $state<Set<string>>(new Set())

/**
 * PRs whose last submit ended without an answer.
 *
 * Latched rather than merely reported: the reviews API has no idempotency key,
 * so re-tapping Post after an unanswered submit is exactly how a reviewer ends
 * up having posted twice. Clearing it is an explicit act — "I checked, post
 * anyway" — or a submit that did come back.
 */
export const unknownOutcome = {
  pending: (url: string): boolean => unknown.has(url),
  raise(url: string): void {
    unknown = new Set(unknown).add(url)
  },
  clear(url: string): void {
    const next = new Set(unknown)
    next.delete(url)
    unknown = next
  },
}
