import { commentableLines } from '../../shared/screenprs'
import { parseUnifiedDiff } from '../../shared/parseDiff'
import type { ReviewChange, ReviewPrRef, ReviewThreadAnchor, ReviewThreadOrigin } from '../../shared/review-room'
import { addMainReviewThread, appendReviewMessage, threadsForReview } from '../review-room-store'
import { repoOf } from './stack-base'
import { runGh } from './gh'

interface GithubComment {
  id: string
  databaseId?: number
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
        nodes { id isResolved isOutdated path line originalLine diffSide comments(first: 100) { nodes { id databaseId author { login } body } pageInfo { hasNextPage endCursor } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

const COMMENTS_QUERY = `
query ReviewThreadComments($id: ID!, $cursor: String) {
  node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { nodes { id databaseId author { login } body } pageInfo { hasNextPage endCursor } } } }
}`

function parsedComments(value: unknown): GithubComment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): GithubComment[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const row = entry as RawComment
    if (typeof row.id !== 'string' || typeof row.body !== 'string') return []
    const author = typeof row.author?.login === 'string' ? row.author.login : 'unknown'
    return [{ id: row.id, ...(typeof row.databaseId === 'number' ? { databaseId: row.databaseId } : {}), author, body: row.body }]
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
    if (!root) return []
    const anchor = lineAnchor(layer, thread, diff, isolatedBase) ?? { kind: 'pr' as const, pr: layer.number }
    const outside = anchor.kind === 'pr'
      ? `On code outside this layer's diff (${thread.path}:${thread.line ?? thread.originalLine ?? '?'} ${thread.diffSide}).\n\n`
      : ''
    return [{
      anchor,
      origin: {
        kind: 'github',
        threadNodeId: thread.id,
        rootCommentId: String(root.databaseId ?? root.id),
        author: root.author,
        isResolved: thread.isResolved,
      },
      status: thread.isResolved ? 'done' : 'open',
      outdated: thread.isOutdated,
      messages: thread.comments.map((comment, index) => ({
        author: 'reviewer',
        body: `${index === 0 ? outside : ''}${comment.body}`,
      })),
    }]
  })
}

const cache = new Map<string, Promise<GithubReviewThread[]>>()

export async function importGithubReviewThreads(
  reviewId: string,
  layer: ReviewPrRef,
  diff: string,
  isolatedBase = false,
): Promise<ReviewChange[]> {
  const key = `${layer.url}\0${layer.headSha}`
  let fetched = cache.get(key)
  if (!fetched) {
    fetched = fetchGithubReviewThreads(layer)
    cache.set(key, fetched)
  }
  const existing = new Set(
    threadsForReview(reviewId).flatMap((thread) => thread.origin.kind === 'github' ? [thread.origin.threadNodeId] : []),
  )
  const changes: ReviewChange[] = []
  for (const imported of mapGithubReviewThreads(layer, diff, await fetched, isolatedBase)) {
    if (existing.has(imported.origin.threadNodeId)) continue
    const first = imported.messages[0]!
    const change = addMainReviewThread({
      reviewId,
      anchor: imported.anchor,
      origin: imported.origin,
      author: first.author,
      body: first.body,
      status: imported.status,
      outdated: imported.outdated,
    })
    changes.push(change)
    for (const message of imported.messages.slice(1)) {
      const appended = appendReviewMessage(change.threadId!, message.author, message.body)
      if (appended) changes.push(appended)
    }
  }
  return changes
}

export function resetGithubReviewThreadsCache(): void {
  cache.clear()
}
