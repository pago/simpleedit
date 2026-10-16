#!/usr/bin/env node
/**
 * Fake `gh` for the Review Room E2E tests (e2e/review-room.test.ts), run by a
 * one-line `gh` wrapper the test puts first on PATH.
 *
 * `FAKE_GH_DIR` holds:
 *  - fixture.json  what GitHub knows: the viewer, the repo, its PRs (metadata,
 *                  diff, commits) and each PR's existing review threads
 *  - state.json    pending and submitted reviews this fake has been given,
 *                  kept across calls (every `gh` call is its own process)
 *  - log.jsonl     one line per call: argv, stdin and, for GraphQL, the
 *                  operation, its variables and the answer
 *
 * Answers follow GitHub's shapes closely enough for main's strict parsers;
 * anything unknown fails like a 404 does, so a new call shows up as a
 * failure, not as a silently wrong answer.
 */
import fs from 'fs'
import path from 'path'

const dir = process.env.FAKE_GH_DIR
if (!dir) {
  process.stderr.write('fake gh: FAKE_GH_DIR is not set\n')
  process.exit(1)
}
const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'))
const statePath = path.join(dir, 'state.json')
const args = process.argv.slice(2)

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const input = args.includes('--input') ? readStdin() : ''

function log(entry) {
  fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ args, ...entry })}\n`)
}

function out(text) {
  process.stdout.write(text)
}

function notFound(what) {
  process.stderr.write(`gh: Not Found (HTTP 404): ${what}\n`)
  process.exit(1)
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {
    return { seq: 0, reviews: [] }
  }
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
}

const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const prByUrl = (url) => fixture.prs.find((pr) => pr.url === url.replace(/\/$/, ''))
const prByNumber = (number) => fixture.prs.find((pr) => pr.number === number)

function prView(pr) {
  return {
    url: pr.url,
    number: pr.number,
    title: pr.title,
    author: { login: pr.author },
    isDraft: false,
    state: 'OPEN',
    closedAt: null,
    baseRefName: pr.baseRefName,
    baseRefOid: pr.baseRefOid,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    body: pr.body,
    latestReviews: [],
    reviews: [],
    closingIssuesReferences: [],
    isCrossRepository: false,
    commits: pr.commits.map((c) => ({ oid: c.oid, messageHeadline: c.subject, authoredDate: c.authoredAt })),
  }
}

// ── GraphQL ──────────────────────────────────────────────────────────────────

const REVIEW_STATE = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }

function commentNode(c) {
  return {
    id: c.id,
    fullDatabaseId: c.databaseId,
    body: c.body,
    commit: { oid: c.commitOid },
    path: c.path,
    line: c.line,
    originalLine: c.line,
    startLine: c.startLine ?? null,
    originalStartLine: c.startLine ?? null,
    diffSide: c.side,
  }
}

function newComment(state, review, fields) {
  state.seq += 1
  const c = { id: `PRRC_e2e_${state.seq}`, databaseId: String(900000 + state.seq), commitOid: review.commitOid, ...fields }
  review.comments.push(c)
  return c
}

function reviewWithComment(state, id) {
  for (const review of state.reviews) {
    const comment = review.comments.find((c) => c.id === id)
    if (comment) return { review, comment }
  }
  return null
}

function existingThread(threadId) {
  for (const threads of Object.values(fixture.threads ?? {})) {
    const thread = threads.find((t) => t.id === threadId)
    if (thread) return thread
  }
  return null
}

const gqlError = (message, type) => ({ errors: [{ message, type }] })

function graphql(operation, variables) {
  const state = loadState()
  const v = variables ?? {}
  const i = v.input ?? {}
  switch (operation) {
    case 'ReviewThreads': {
      const nodes = fixture.threads?.[String(v.number)] ?? []
      return { data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } }
    }
    case 'PendingReviews': {
      const pr = prByNumber(v.number)
      if (!pr) return { data: { repository: { pullRequest: null } } }
      const nodes = state.reviews
        .filter((r) => r.prNumber === pr.number && r.state === 'PENDING')
        .map((r) => ({ id: r.id, body: r.body, viewerDidAuthor: true, commit: { oid: r.commitOid }, comments: { totalCount: r.comments.length } }))
      return { data: { repository: { pullRequest: { id: `PR_e2e_${pr.number}`, headRefOid: pr.headRefOid, reviews: { nodes } } } } }
    }
    case 'AddReview': {
      const number = Number(String(i.pullRequestId).replace('PR_e2e_', ''))
      if (!prByNumber(number)) return gqlError('Could not resolve to a node', 'NOT_FOUND')
      if (state.reviews.some((r) => r.prNumber === number && r.state === 'PENDING')) {
        return gqlError('User can only have one pending review per pull request', 'UNPROCESSABLE')
      }
      state.seq += 1
      const review = { id: `PRR_e2e_${number}_${state.seq}`, prNumber: number, state: 'PENDING', body: i.body ?? '', commitOid: i.commitOID, comments: [] }
      state.reviews.push(review)
      for (const t of i.threads ?? []) {
        newComment(state, review, { path: t.path, line: t.line, startLine: t.startLine, side: t.side, body: t.body })
      }
      saveState(state)
      return { data: { addPullRequestReview: { pullRequestReview: { id: review.id } } } }
    }
    case 'ReviewComments': {
      const review = state.reviews.find((r) => r.id === v.id)
      if (!review) return { data: { node: null } }
      return { data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: review.comments.map(commentNode) } } } }
    }
    case 'ReviewState': {
      const review = state.reviews.find((r) => r.id === v.id)
      return { data: { node: review ? { state: review.state, url: `${prByNumber(review.prNumber)?.url}#pullrequestreview-${review.id}` } : null } }
    }
    case 'ReplyContext': {
      const thread = existingThread(v.id)
      if (!thread) return { data: { node: null } }
      return { data: { node: { path: thread.path, line: thread.line, comments: { nodes: thread.comments.nodes.slice(0, 1).map((c) => ({ body: c.body, author: c.author })) } } } }
    }
    case 'AddThread': {
      const review = state.reviews.find((r) => r.id === i.pullRequestReviewId)
      if (!review) return gqlError('Could not resolve to a node', 'NOT_FOUND')
      const c = newComment(state, review, { path: i.path, line: i.line, startLine: i.startLine, side: i.side, body: i.body })
      saveState(state)
      return { data: { addPullRequestReviewThread: { thread: { comments: { nodes: [commentNode(c)] } } } } }
    }
    case 'AddReply': {
      const review = state.reviews.find((r) => r.id === i.pullRequestReviewId)
      const thread = existingThread(i.pullRequestReviewThreadId)
      if (!review || !thread) return gqlError('Could not resolve to a node', 'NOT_FOUND')
      const c = newComment(state, review, { path: thread.path, line: thread.line, side: thread.diffSide, body: i.body, replyTo: thread.id })
      saveState(state)
      return { data: { addPullRequestReviewThreadReply: { comment: commentNode(c) } } }
    }
    case 'UpdateComment': {
      const found = reviewWithComment(state, i.pullRequestReviewCommentId)
      if (!found) return gqlError('Could not resolve to a node', 'NOT_FOUND')
      found.comment.body = i.body
      saveState(state)
      return { data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: found.comment.id } } } }
    }
    case 'DeleteComment': {
      const found = reviewWithComment(state, i.id)
      if (!found) return gqlError('Could not resolve to a node', 'NOT_FOUND')
      found.review.comments = found.review.comments.filter((c) => c !== found.comment)
      saveState(state)
      return { data: { deletePullRequestReviewComment: { pullRequestReview: { id: found.review.id } } } }
    }
    case 'DeleteReview': {
      const review = state.reviews.find((r) => r.id === i.pullRequestReviewId)
      if (!review || review.state !== 'PENDING') return gqlError('Could not resolve to a node', 'NOT_FOUND')
      state.reviews = state.reviews.filter((r) => r !== review)
      saveState(state)
      return { data: { deletePullRequestReview: { pullRequestReview: { id: review.id } } } }
    }
    case 'SubmitReview': {
      const review = state.reviews.find((r) => r.id === i.pullRequestReviewId)
      if (!review) return gqlError('Could not resolve to a node', 'NOT_FOUND')
      if (review.state !== 'PENDING') return gqlError('Can not submit a review that is not pending', 'UNPROCESSABLE')
      review.state = REVIEW_STATE[i.event] ?? 'COMMENTED'
      review.body = i.body ?? ''
      saveState(state)
      const url = `${prByNumber(review.prNumber)?.url}#pullrequestreview-${review.id}`
      return { data: { submitPullRequestReview: { pullRequestReview: { id: review.id, url, state: review.state } } } }
    }
    default:
      return gqlError(`fake gh does not know the operation ${operation}`, 'NOT_FOUND')
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const [cmd, sub] = args
if (cmd === 'api' && args.includes('graphql')) {
  let request = {}
  try {
    request = JSON.parse(input)
  } catch {
    /* logged as is */
  }
  const operation = /\b(?:query|mutation)\s+(\w+)/.exec(request.query ?? '')?.[1] ?? null
  const answer = graphql(operation, request.variables)
  log({ graphql: { operation, variables: request.variables ?? null, answer } })
  out(JSON.stringify(answer))
  process.exit(answer.errors ? 1 : 0)
}

log({ input: input || undefined })

if (cmd === 'api') {
  const endpoint = args.slice(1).find((a, idx) => !a.startsWith('-') && !['--hostname', '-H', '--jq'].includes(args[idx]))
  if (endpoint === 'user') {
    out(args.includes('--jq') ? `${fixture.login}\n` : JSON.stringify({ login: fixture.login }))
    process.exit(0)
  }
  if (endpoint && /\/compare\//.test(endpoint)) {
    if (args.some((a) => a.includes('application/vnd.github.diff'))) out('')
    else out(JSON.stringify({ status: 'ahead', ahead_by: 1, behind_by: 0, commits: [] }))
    process.exit(0)
  }
  notFound(endpoint ?? args.join(' '))
}

if (cmd === 'search' && sub === 'prs') {
  out(
    JSON.stringify(
      fixture.prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        updatedAt: new Date().toISOString(),
        author: { login: pr.author },
        repository: { name: fixture.repo.name, nameWithOwner: `${fixture.repo.owner}/${fixture.repo.name}` },
      }))
    )
  )
  process.exit(0)
}

if (cmd === 'repo' && sub === 'view') {
  out(JSON.stringify({ defaultBranchRef: { name: fixture.repo.defaultBranch } }))
  process.exit(0)
}

if (cmd === 'pr') {
  if (sub === 'list') {
    const head = flag('--head')
    out(
      JSON.stringify(
        fixture.prs
          .filter((pr) => pr.headRefName === head)
          .map((pr) => ({ ...prView(pr), state: 'OPEN', isCrossRepository: false }))
      )
    )
    process.exit(0)
  }
  const pr = prByUrl(args[2] ?? '')
  if (!pr) {
    process.stderr.write(`no pull requests found for ${args[2]}\n`)
    process.exit(1)
  }
  if (sub === 'view') {
    out(JSON.stringify(prView(pr)))
    process.exit(0)
  }
  if (sub === 'checks') {
    out('[]')
    process.exit(0)
  }
  if (sub === 'diff') {
    out(pr.diff)
    process.exit(0)
  }
}

notFound(args.join(' '))
