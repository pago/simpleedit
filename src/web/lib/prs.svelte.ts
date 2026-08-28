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
 *
 * Both live for the page: a reconnect leaves them alone (they are client-side
 * and nothing about them is stale), and a reload drops them.
 */

/** What a tap on a diff line hands to the comment sheet. */
export interface CommentTarget {
  file: string
  /** Absent when the tapped line has no RIGHT-side number — i.e. a deletion. */
  line?: string
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
    .invoke('screenprs:pr-diff', { url })
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
