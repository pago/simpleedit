import { commentableLines } from '../../shared/screenprs'
import { parseUnifiedDiff } from '../../shared/parseDiff'
import { fitReviewBody, type ReviewChange, type ReviewPrRef, type ReviewThreadAnchor, type ReviewThreadOrigin } from '../../shared/review-room'
import { addMainReviewThread, appendReviewMessage, threadsForReview, updateMainReviewThread } from '../review-room-store'
import { getDb, transaction } from '../db'
import { repoOf } from './stack-base'
import { runGh } from './gh'

interface GithubComment {
  id: string
  /** The REST id (`fullDatabaseId`: `databaseId` is an Int32 that newer ids outgrow). */
  databaseId?: string
  author: string
  body: string
}

export interface GithubReviewThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line?: number
  originalLine?: number
  diffSide: 'LEFT' | 'RIGHT'
  comments: GithubComment[]
}

export interface ImportedGithubThread {
  anchor: ReviewThreadAnchor
  origin: Extract<ReviewThreadOrigin, { kind: 'github' }>
  status: 'open' | 'done'
  outdated: boolean
  messages: Array<{ author: 'reviewer'; body: string }>
}

interface PageInfo {
  hasNextPage?: boolean
  endCursor?: string | null
}

interface RawComment {
  id?: unknown
  databaseId?: unknown
  fullDatabaseId?: unknown
  author?: { login?: unknown } | null
  body?: unknown
}

interface RawThread {
  id?: unknown
  isResolved?: unknown
  isOutdated?: unknown
  path?: unknown
  line?: unknown
  originalLine?: unknown
  diffSide?: unknown
  comments?: { nodes?: unknown; pageInfo?: PageInfo } | null
}

interface GraphqlEnvelope {
  data?: {
    repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown; pageInfo?: PageInfo } | null } | null } | null
    node?: { comments?: { nodes?: unknown; pageInfo?: PageInfo } | null } | null
  }
}

const THREADS_QUERY = `
query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes { id isResolved isOutdated path line originalLine diffSide comments(first: 100) { nodes { id databaseId fullDatabaseId author { login } body } pageInfo { hasNextPage endCursor } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

const COMMENTS_QUERY = `
query ReviewThreadComments($id: ID!, $cursor: String) {
  node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { nodes { id databaseId fullDatabaseId author { login } body } pageInfo { hasNextPage endCursor } } } }
}`

function parsedComments(value: unknown): GithubComment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): GithubComment[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const row = entry as RawComment
    if (typeof row.id !== 'string' || typeof row.body !== 'string') return []
    const author = typeof row.author?.login === 'string' ? row.author.login : 'unknown'
    const restId = typeof row.fullDatabaseId === 'string' && /^\d+$/.test(row.fullDatabaseId)
      ? row.fullDatabaseId
      : typeof row.databaseId === 'number' && Number.isSafeInteger(row.databaseId) ? String(row.databaseId) : undefined
    return [{ id: row.id, ...(restId ? { databaseId: restId } : {}), author, body: row.body }]
  })
}

function parsedThread(value: unknown): { thread: GithubReviewThread; pageInfo: PageInfo } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as RawThread
  if (
    typeof row.id !== 'string' || typeof row.isResolved !== 'boolean' || typeof row.isOutdated !== 'boolean' ||
    typeof row.path !== 'string' || (row.diffSide !== 'LEFT' && row.diffSide !== 'RIGHT')
  ) return null
  const line = typeof row.line === 'number' && Number.isSafeInteger(row.line) && row.line > 0 ? row.line : undefined
  const originalLine = typeof row.originalLine === 'number' && Number.isSafeInteger(row.originalLine) && row.originalLine > 0
    ? row.originalLine
    : undefined
  return {
    thread: {
      id: row.id,
      isResolved: row.isResolved,
      isOutdated: row.isOutdated,
      path: row.path,
      ...(line ? { line } : {}),
      ...(originalLine ? { originalLine } : {}),
      diffSide: row.diffSide,
      comments: parsedComments(row.comments?.nodes),
    },
    pageInfo: row.comments?.pageInfo ?? {},
  }
}

type GraphqlRunner = (query: string, variables: Record<string, unknown>, host: string) => Promise<GraphqlEnvelope>

const defaultRunner: GraphqlRunner = async (query, variables, host) =>
  JSON.parse(await runGh(['api', 'graphql', '--hostname', host, '--input', '-'], {
    input: JSON.stringify({ query, variables }),
  })) as GraphqlEnvelope

export async function fetchGithubReviewThreads(
  layer: ReviewPrRef,
  run: GraphqlRunner = defaultRunner,
): Promise<GithubReviewThread[]> {
  const repo = repoOf(layer.url)
  const threads: GithubReviewThread[] = []
  let cursor: string | null = null
  do {
    const envelope = await run(THREADS_QUERY, { owner: repo.owner, name: repo.name, number: layer.number, cursor }, repo.host)
    const connection = envelope.data?.repository?.pullRequest?.reviewThreads
    const page = Array.isArray(connection?.nodes) ? connection.nodes : []
    for (const raw of page) {
      const parsed = parsedThread(raw)
      if (!parsed) continue
      let commentCursor = parsed.pageInfo.endCursor ?? null
      while (parsed.pageInfo.hasNextPage && commentCursor) {
        const comments = await run(COMMENTS_QUERY, { id: parsed.thread.id, cursor: commentCursor }, repo.host)
        const next = comments.data?.node?.comments
        parsed.thread.comments.push(...parsedComments(next?.nodes))
        if (!next?.pageInfo?.hasNextPage || !next.pageInfo.endCursor) break
        commentCursor = next.pageInfo.endCursor
      }
      threads.push(parsed.thread)
    }
    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor ?? null : null
  } while (cursor)
  return threads
}

function lineAnchor(layer: ReviewPrRef, thread: GithubReviewThread, diff: string, isolatedBase: boolean): ReviewThreadAnchor | null {
  const line = thread.line ?? thread.originalLine
  if (!line || thread.isOutdated || (isolatedBase && thread.diffSide === 'LEFT')) return null
  if (!commentableLines(diff).get(thread.path)?.[thread.diffSide].has(line)) return null
  const file = parseUnifiedDiff(diff).find((candidate) => candidate.path === thread.path || candidate.oldPath === thread.path)
  if (!file) return null
  const rowIndex = file.rows.findIndex((row) => (thread.diffSide === 'RIGHT' ? row.newNo : row.oldNo) === line)
  if (rowIndex < 0) return null
  const content = file.rows.filter((row) => row.kind !== 'hunk')
  const contentIndex = content.indexOf(file.rows[rowIndex]!)
  return {
    kind: 'line',
    pr: layer.number,
    headSha: layer.headSha,
    path: file.path,
    side: thread.diffSide,
    startLine: line,
    endLine: line,
    snippet: file.rows[rowIndex]!.text,
    before: content.slice(Math.max(0, contentIndex - 3), contentIndex).map((row) => row.text).join('\n'),
    after: content.slice(contentIndex + 1, contentIndex + 4).map((row) => row.text).join('\n'),
  }
}

export function mapGithubReviewThreads(
  layer: ReviewPrRef,
  diff: string,
  threads: readonly GithubReviewThread[],
  isolatedBase = false,
): ImportedGithubThread[] {
  return threads.flatMap((thread): ImportedGithubThread[] => {
    const root = thread.comments[0]
    // A reply posts against the root's REST id; a root without one can't be answered.
    if (!root || root.databaseId === undefined) return []
    const anchor = lineAnchor(layer, thread, diff, isolatedBase) ?? { kind: 'pr' as const, pr: layer.number }
    const outside = anchor.kind === 'pr'
      ? `On code outside this layer's diff (${thread.path}:${thread.line ?? thread.originalLine ?? '?'} ${thread.diffSide}).\n\n`
      : ''
    return [{
      anchor,
      origin: {
        kind: 'github',
        threadNodeId: thread.id,
        rootCommentId: root.databaseId,
        author: root.author,
        isResolved: thread.isResolved,
      },
      status: thread.isResolved ? 'done' : 'open',
      outdated: thread.isOutdated,
      messages: thread.comments.map((comment, index) => ({
        author: 'reviewer',
        body: fitReviewBody(`${index === 0 ? outside : ''}${comment.body.trim() ? comment.body : '(empty comment)'}`),
      })),
    }]
  })
}

/** Long enough to share one fetch between the layers of a room opening, short enough that new replies arrive. */
const CACHE_MS = 60_000

const cache = new Map<string, { at: number; threads: Promise<GithubReviewThread[]> }>()
const importing = new Map<string, Promise<unknown>>()

function fetchCached(layer: ReviewPrRef): Promise<GithubReviewThread[]> {
  const key = `${layer.url}\0${layer.headSha}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.threads
  const threads = fetchGithubReviewThreads(layer)
  cache.set(key, { at: Date.now(), threads })
  // A failure (rate limit, network) must not stick until restart.
  threads.catch(() => {
    if (cache.get(key)?.threads === threads) cache.delete(key)
  })
  return threads
}

/**
 * Import a layer's GitHub threads into a review: new threads are added, known
 * ones get the replies posted since and their resolved flag. Imports of one
 * review run one at a time, so two can't both add a thread.
 */
export function importGithubReviewThreads(
  reviewId: string,
  layer: ReviewPrRef,
  diff: string,
  isolatedBase = false,
): Promise<ReviewChange[]> {
  const previous = importing.get(reviewId) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(async () => applyImport(reviewId, mapGithubReviewThreads(layer, diff, await fetchCached(layer), isolatedBase)))
  importing.set(reviewId, run)
  void run.finally(() => {
    if (importing.get(reviewId) === run) importing.delete(reviewId)
  }).catch(() => {})
  return run
}

function applyImport(reviewId: string, imported: readonly ImportedGithubThread[]): ReviewChange[] {
  return transaction(getDb(), () => {
    const known = new Map(
      threadsForReview(reviewId).flatMap((thread) => thread.origin.kind === 'github' ? [[thread.origin.threadNodeId, thread] as const] : []),
    )
    const changes: ReviewChange[] = []
    for (const entry of imported) {
      const existing = known.get(entry.origin.threadNodeId)
      if (existing) {
        if (existing.origin.kind === 'github' && existing.origin.isResolved !== entry.origin.isResolved) {
          const change = updateMainReviewThread(existing.id, { origin: { ...existing.origin, isResolved: entry.origin.isResolved } })
          if (change) changes.push(change)
        }
        const stored = existing.messages.filter((message) => message.author === 'reviewer').length
        for (const message of entry.messages.slice(stored)) {
          const appended = appendReviewMessage(existing.id, message.author, message.body)
          if (appended) changes.push(appended)
        }
        continue
      }
      const [first, ...replies] = entry.messages
      if (!first) continue
      const change = addMainReviewThread({
        reviewId,
        anchor: entry.anchor,
        origin: entry.origin,
        author: first.author,
        body: first.body,
        status: entry.status,
        outdated: entry.outdated,
      })
      changes.push(change)
      for (const message of replies) {
        const appended = appendReviewMessage(change.threadId, message.author, message.body)
        if (appended) changes.push(appended)
      }
    }
    return changes
  })
}

export function resetGithubReviewThreadsCache(): void {
  cache.clear()
  importing.clear()
}
