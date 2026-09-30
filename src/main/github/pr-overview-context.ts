/**
 * What the PR Overview reads, gathered over `gh`: the review diff and meta
 * (reused from triage and `stack-base.ts`), commits, linked issues, the
 * discussion, the changeset, CI, key files at head and on the default branch,
 * the nearest `CLAUDE.md`, and the findings triage and deep review already made.
 *
 * `renderOverviewInput` fills one ~150 KB prompt input in that order, except
 * that the existing findings go before the files.
 * Each source has its own cap too, so a huge diff can't starve the discussion.
 * Whatever is cut is listed in the input, so the model can say "not seen"
 * instead of guessing. The parsers and the budgeting are pure and unit-tested;
 * the gh calls are a thin layer over `runGh`, and any one of them failing
 * leaves a note rather than failing the overview.
 */
import { runGh } from './gh'
import { parsePrCommits, repoOf, type BaseResolver } from './stack-base'
import type { DeepFinding, PrContext, TriageFinding } from '../../shared/screenprs'
import type { OverviewFacts } from '../../shared/pr-overview'

// ── diff files ──────────────────────────────────────────────────────────────

export interface DiffFileChurn {
  path: string
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'modified'
}

/**
 * The files of a unified diff with their churn. Read from the review diff, not
 * GitHub's file list, so a polluted stack's lower-layer files never count.
 */
export function diffFiles(diff: string): DiffFileChurn[] {
  const files: DiffFileChurn[] = []
  let cur: DiffFileChurn | null = null
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line)
      cur = { path: m ? m[1] : line.slice(11), additions: 0, deletions: 0, status: 'modified' }
      files.push(cur)
      inHunk = false
    } else if (!cur) {
      continue
    } else if (line.startsWith('@@')) {
      inHunk = true
    } else if (inHunk) {
      if (line.startsWith('+')) cur.additions++
      else if (line.startsWith('-')) cur.deletions++
    } else if (line.startsWith('new file mode')) {
      cur.status = 'added'
    } else if (line.startsWith('deleted file mode')) {
      cur.status = 'deleted'
    } else if (line.startsWith('+++ b/')) {
      cur.path = line.slice(6)
    }
  }
  return files
}

/**
 * Files whose full text tells a reader nothing the hunks don't: lockfiles,
 * generated output, snapshots, tests, binaries, changesets and changelogs.
 */
const NOT_KEY: RegExp[] = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json|go\.sum|Gemfile\.lock|poetry\.lock)$/,
  /\.lock$/,
  /(^|\/)(dist|build|out|coverage|generated|__generated__|vendor|node_modules)\//,
  /\.(min\.js|map|snap|d\.ts)$/,
  /\.generated\./,
  /(^|\/)__snapshots__\//,
  /(^|\/)(__tests__|__mocks__|tests?|e2e|fixtures)\//,
  /\.(test|spec|stories)\.[cm]?[jt]sx?$/,
  /\.(png|jpe?g|gif|webp|ico|svg|pdf|woff2?|ttf|otf|mp4|zip|gz)$/i,
  /(^|\/)\.changeset\//,
  /(^|\/)CHANGELOG\.md$/i,
]

export function isKeyFileCandidate(path: string): boolean {
  return !NOT_KEY.some((re) => re.test(path))
}

/**
 * The files worth reading whole, most-changed first. A deleted file has no
 * head version to read, so it never qualifies.
 */
export function selectKeyFiles(files: DiffFileChurn[], k = 4): DiffFileChurn[] {
  return files
    .filter((f) => f.status !== 'deleted' && isKeyFileCandidate(f.path))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path))
    .slice(0, k)
}

/**
 * Where a `CLAUDE.md` governing `path` could live, nearest directory first,
 * ending at the repo root.
 */
export function claudeMdCandidates(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  const out: string[] = []
  for (let i = parts.length; i >= 0; i--) out.push([...parts.slice(0, i), 'CLAUDE.md'].join('/'))
  return out
}

// ── linked issues ───────────────────────────────────────────────────────────

export interface IssueRef {
  owner: string
  repo: string
  number: number
}

const refId = (r: IssueRef): string => `${r.owner}/${r.repo}#${r.number}`.toLowerCase()

/**
 * Issue and PR references in a PR body: `#12`, `owner/repo#12`, and issue or
 * pull URLs. Fenced and inline code is skipped (a `#12` there is rarely a
 * reference), and so is the PR itself.
 */
export function parseIssueRefs(body: string, self: IssueRef): IssueRef[] {
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  const refs: IssueRef[] = []
  const seen = new Set<string>([refId(self)])
  const add = (r: IssueRef): void => {
    const id = refId(r)
    if (seen.has(id) || r.number <= 0) return
    seen.add(id)
    refs.push(r)
  }
  const pattern =
    /https?:\/\/[^\s/]+\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)|(?<![\w/#.:-])([\w.-]+)\/([\w.-]+)#(\d+)\b|(?<![\w/&#])#(\d+)\b/g
  for (const m of text.matchAll(pattern)) {
    if (m[1]) add({ owner: m[1], repo: m[2], number: Number(m[3]) })
    else if (m[4]) add({ owner: m[4], repo: m[5], number: Number(m[6]) })
    else add({ owner: self.owner, repo: self.repo, number: Number(m[7]) })
  }
  return refs
}

/** Closing references first (GitHub's own link), then body references, deduped. */
export function linkedIssues(closing: IssueRef[], body: string, self: IssueRef, max = 3): IssueRef[] {
  const out: IssueRef[] = []
  const seen = new Set<string>([refId(self)])
  for (const r of [...closing, ...parseIssueRefs(body, self)]) {
    const id = refId(r)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(r)
  }
  return out.slice(0, max)
}

// ── discussion ──────────────────────────────────────────────────────────────

export interface DiscussionItem {
  kind: 'line' | 'comment' | 'review'
  author: string
  /** Written by the current user — the prompt attributes it as "you noted". */
  own: boolean
  body: string
  path?: string
  line?: number
  /** A review's verdict (`APPROVED`, `CHANGES_REQUESTED`, …). */
  state?: string
  at?: string
}

interface RawUserComment {
  user?: { login?: string; type?: string } | null
  body?: string | null
  path?: string
  line?: number | null
  original_line?: number | null
  created_at?: string
}

interface RawReviewBody {
  author?: { login?: string } | null
  body?: string | null
  state?: string
  submittedAt?: string
}

/** One JSON value per line, as `gh api --paginate --jq '.[]'` prints them. */
export function parseNdjson<T>(text: string): T[] {
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      /* a partial line from a killed call */
    }
  }
  return out
}

const CHANGESET_BOT = /^changeset-bot(\[bot\])?$/i
const MAX_COMMENT_CHARS = 1_500

const isBot = (c: RawUserComment): boolean => c.user?.type === 'Bot' || /\[bot\]$/i.test(c.user?.login ?? '')

function clip(body: string): string {
  const text = body.trim()
  return text.length > MAX_COMMENT_CHARS ? `${text.slice(0, MAX_COMMENT_CHARS)} …[comment truncated]` : text
}

/**
 * The discussion in time order: line comments with their `path:line`, PR
 * comments, and review bodies. Empty bodies are dropped (an approval with no
 * text says nothing a reviewer badge doesn't), and so is changeset-bot, which
 * the changeset section reads instead. A bot keeps only its latest comment:
 * bots re-post on every push (snapshot and preview reports), and forty copies
 * would crowd out the people. Each body is clipped for the same reason.
 */
export function parseDiscussion(input: {
  lineComments: RawUserComment[]
  comments: RawUserComment[]
  reviews: RawReviewBody[]
  handle: string
}): DiscussionItem[] {
  const own = (login: string): boolean => !!input.handle && login.toLowerCase() === input.handle.toLowerCase()
  const items: DiscussionItem[] = []
  for (const c of input.lineComments) {
    const author = c.user?.login ?? 'unknown'
    if (!c.body?.trim()) continue
    const line = c.line ?? c.original_line ?? undefined
    items.push({ kind: 'line', author, own: own(author), body: clip(c.body), path: c.path, line, at: c.created_at })
  }
  const latestBot = new Map<string, RawUserComment>()
  for (const c of input.comments) if (isBot(c)) latestBot.set(c.user?.login ?? '', c)
  for (const c of input.comments) {
    const author = c.user?.login ?? 'unknown'
    if (!c.body?.trim() || CHANGESET_BOT.test(author)) continue
    if (isBot(c) && latestBot.get(author) !== c) continue
    items.push({ kind: 'comment', author, own: own(author), body: clip(c.body), at: c.created_at })
  }
  for (const r of input.reviews) {
    const author = r.author?.login ?? 'unknown'
    if (!r.body?.trim()) continue
    items.push({ kind: 'review', author, own: own(author), body: clip(r.body), state: r.state, at: r.submittedAt })
  }
  return items.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
}

// ── changeset ───────────────────────────────────────────────────────────────

export interface ChangesetInfo {
  /** `.changeset/*.md` files in the review diff. */
  files: string[]
  /** changeset-bot's latest verdict line, if it commented. */
  bot?: string
  /**
   * Set for a stacked PR: the lower layer, as `#N` or its branch. The changeset
   * may live there, which is not the same as missing.
   */
  stackedOn?: string
}

export function changesetInfo(
  files: DiffFileChurn[],
  comments: RawUserComment[],
  stackedOn: string | undefined
): ChangesetInfo {
  const changesets = files
    .filter((f) => f.status !== 'deleted' && /(^|\/)\.changeset\/[^/]+\.md$/.test(f.path) && !/README\.md$/i.test(f.path))
    .map((f) => f.path)
  const bot = [...comments].reverse().find((c) => CHANGESET_BOT.test(c.user?.login ?? ''))?.body
  const verdict = bot?.match(/changeset detected|no changeset found/i)?.[0]
  return { files: changesets, ...(verdict ? { bot: verdict } : {}), ...(stackedOn ? { stackedOn } : {}) }
}

// ── the gathered context ────────────────────────────────────────────────────

export interface KeyFile {
  path: string
  /** Text at the PR head; absent when it couldn't be read or was skipped. */
  head?: string
  /** Text on the default branch; absent for a new file. */
  base?: string
  skipped?: string
}

export interface OverviewContext {
  pr: PrContext
  handle: string
  defaultBranch?: string
  isDraft: boolean
  /** Commit subjects, the PR's own only when the base is polluted. */
  commits: string[]
  /** Commits left out because they belong to a lower stack layer. */
  foreignCommits: number
  issues: { ref: string; title: string; body: string }[]
  discussion: DiscussionItem[]
  changeset: ChangesetInfo
  keyFiles: KeyFile[]
  guides: { path: string; text: string }[]
  triage: TriageFinding[]
  deep: DeepFinding[]
  /** Sources that could not be fetched. */
  unavailable: string[]
}

export function overviewFacts(ctx: Pick<OverviewContext, 'isDraft' | 'changeset'>): OverviewFacts {
  const { changeset } = ctx
  return {
    draft: ctx.isDraft,
    changeset: changeset.files.length > 0 ? 'yes' : changeset.stackedOn ? 'base' : 'no',
    ...(changeset.files.length === 0 && changeset.stackedOn ? { changesetBase: changeset.stackedOn } : {}),
  }
}

// ── budgeting ───────────────────────────────────────────────────────────────

export const OVERVIEW_INPUT_BUDGET = 150_000

export interface InputSection {
  tag: string
  body: string
  /** This section's own ceiling, before the shared budget. */
  cap: number
}

const kb = (n: number): string => `${Math.max(1, Math.round(n / 1000))} KB`

/** Cut at a line boundary so no half line reaches the model. */
function cutAt(text: string, max: number): string {
  const cut = text.slice(0, max)
  const nl = cut.lastIndexOf('\n')
  return nl > max * 0.5 ? cut.slice(0, nl) : cut
}

/**
 * Fill `budget` with `sections` in order. A section gets what is left of the
 * budget up to its own cap; below a useful minimum it is omitted. Returns the
 * notes on everything cut, which the input carries as its "not seen" block.
 */
export function assembleInput(sections: InputSection[], budget = OVERVIEW_INPUT_BUDGET): { text: string; notSeen: string[] } {
  const MIN_USEFUL = 400
  const parts: string[] = []
  const notSeen: string[] = []
  let used = 0
  for (const s of sections) {
    if (!s.body) continue
    const allowed = Math.min(s.cap, budget - used)
    let body = s.body
    if (body.length > allowed) {
      if (allowed < MIN_USEFUL) {
        notSeen.push(`${s.tag}: omitted (${kb(body.length)}, over the input budget)`)
        continue
      }
      body = cutAt(body, allowed)
      notSeen.push(`${s.tag}: truncated to ${kb(body.length)} of ${kb(s.body.length)}`)
    }
    used += body.length
    parts.push(`<${s.tag}>\n${body}\n</${s.tag}>`)
  }
  return { text: parts.join('\n\n'), notSeen }
}

function metaSection(ctx: OverviewContext): string {
  const { pr } = ctx
  const lines = [
    `PR: ${pr.owner}/${pr.repo}#${pr.number} — ${pr.title}`,
    `Author: ${pr.author}${pr.author.toLowerCase() === ctx.handle.toLowerCase() ? ' (you)' : ''}`,
    `State: ${ctx.isDraft ? 'draft' : 'ready for review'}`,
    `Base: ${pr.baseRefName}${ctx.defaultBranch && pr.baseRefName !== ctx.defaultBranch ? ` (stacked; the default branch is ${ctx.defaultBranch})` : ''}`,
    `Size (this PR's own diff): +${pr.additions} −${pr.deletions}, ${pr.changedFiles} files`,
  ]
  if (pr.base?.kind === 'polluted') {
    const from = pr.base.basePr != null ? `#${pr.base.basePr}` : pr.baseRefName
    lines.push(
      pr.base.isolated
        ? `Stale base: GitHub's "Files changed" includes ${pr.base.foreign} commit(s) from ${from}. The diff below is only this PR's own commits.`
        : `Stale base: GitHub's diff includes ${pr.base.foreign} commit(s) from ${from}, and they could not be separated. The diff below includes the lower layer; judge only this PR's own commits.`
    )
  }
  if (pr.reviewers.length) lines.push(`Reviews: ${pr.reviewers.map((r) => `${r.login} ${r.state}`).join(', ')}`)
  lines.push('', 'Description:', pr.body.trim() || '(empty)')
  return lines.join('\n')
}

function discussionSection(items: DiscussionItem[]): string {
  if (!items.length) return '(no comments or review bodies)'
  return items
    .map((d) => {
      const who = d.own ? `${d.author} (you)` : d.author
      const where = d.kind === 'line' ? ` on ${d.path}${d.line ? `:${d.line}` : ''}` : ''
      const what = d.kind === 'review' ? ` review ${d.state ?? ''}`.trimEnd() : d.kind === 'line' ? ' line comment' : ' comment'
      return `[${who}${what}${where}]\n${d.body}`
    })
    .join('\n---\n')
}

function changesetSection(c: ChangesetInfo): string {
  const lines = [c.files.length ? `Changeset files in this PR: ${c.files.join(', ')}` : 'No changeset file in this PR.']
  if (c.bot) lines.push(`changeset-bot says: "${c.bot}" (it reads GitHub's diff, which for a stale stack includes the lower layer)`)
  if (!c.files.length && c.stackedOn) lines.push(`Stacked PR: the changeset may be in ${c.stackedOn}. Say so rather than calling it missing.`)
  return lines.join('\n')
}

function ciSection(pr: PrContext): string {
  if (pr.ci === 'failing') return `Failing: ${pr.ciFailing.join(', ') || 'unknown checks'}`
  return pr.ci === 'pending' ? 'Checks are still running.' : 'All checks passed (or none are configured).'
}

const KEY_FILE_VERSION_CAP = 14_000

function keyFilesSection(files: KeyFile[], defaultBranch: string | undefined): string {
  return files
    .map((f) => {
      if (f.skipped) return `=== ${f.path}: not included (${f.skipped})`
      const parts: string[] = []
      if (f.head !== undefined) parts.push(`=== ${f.path} at the PR head\n${cutAt(f.head, KEY_FILE_VERSION_CAP)}`)
      if (f.base !== undefined) parts.push(`=== ${f.path} on ${defaultBranch ?? 'the default branch'}\n${cutAt(f.base, KEY_FILE_VERSION_CAP)}`)
      else parts.push(`=== ${f.path} does not exist on ${defaultBranch ?? 'the default branch'} (new file)`)
      return parts.join('\n\n')
    })
    .join('\n\n')
}

function findingsSection(ctx: OverviewContext): string {
  const lines: string[] = []
  for (const f of ctx.triage) lines.push(`- triage [${f.label}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.title}`)
  for (const f of ctx.deep) lines.push(`- deep review [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.title}`)
  return lines.join('\n')
}

/** The prompt input, in priority order under one budget, with its "not seen" block. */
export function renderOverviewInput(ctx: OverviewContext, budget = OVERVIEW_INPUT_BUDGET): string {
  const commits = ctx.commits.map((s) => `- ${s}`).join('\n')
  const sections: InputSection[] = [
    { tag: 'pr', body: metaSection(ctx), cap: 8_000 },
    { tag: 'diff', body: ctx.pr.diff || '(empty diff)', cap: 80_000 },
    {
      tag: 'commits',
      body: commits + (ctx.foreignCommits ? `\n(${ctx.foreignCommits} lower-layer commit(s) left out)` : ''),
      cap: 4_000,
    },
    {
      tag: 'linked-issues',
      body: ctx.issues.map((i) => `=== ${i.ref}: ${i.title}\n${cutAt(i.body, 4_000)}`).join('\n\n'),
      cap: 12_000,
    },
    { tag: 'discussion', body: discussionSection(ctx.discussion), cap: 16_000 },
    { tag: 'changeset', body: changesetSection(ctx.changeset), cap: 1_500 },
    { tag: 'ci', body: ciSection(ctx.pr), cap: 1_000 },
    // Ahead of the files: small, and what keeps Look into from repeating triage.
    { tag: 'existing-findings', body: findingsSection(ctx), cap: 6_000 },
    { tag: 'key-files', body: keyFilesSection(ctx.keyFiles, ctx.defaultBranch), cap: 40_000 },
    { tag: 'guides', body: ctx.guides.map((g) => `=== ${g.path}\n${g.text}`).join('\n\n'), cap: 12_000 },
  ]
  const { text, notSeen } = assembleInput(sections, budget)
  const unseen = [...ctx.unavailable.map((u) => `${u}: could not be fetched`), ...notSeen]
  return unseen.length ? `${text}\n\n<not-seen>\n${unseen.map((u) => `- ${u}`).join('\n')}\n</not-seen>` : text
}

// ── gh layer ────────────────────────────────────────────────────────────────

/** Files over this are skipped: a key file that large is mostly noise to the overview. */
const MAX_KEY_FILE_BYTES = 40_000
const MAX_GUIDE_BYTES = 12_000

interface RawOverviewView {
  isDraft?: boolean
  closingIssuesReferences?: { number: number; repository?: { name?: string; owner?: { login?: string } } }[] | null
  reviews?: RawReviewBody[] | null
}

const pathUrl = (p: string): string => p.split('/').map(encodeURIComponent).join('/')

/** A file's raw text at `ref`, or undefined when it doesn't exist there. */
async function fileAt(url: string, path: string, ref: string): Promise<string | undefined> {
  const r = repoOf(url)
  try {
    return await runGh([
      'api', '--hostname', r.host, '-H', 'Accept: application/vnd.github.raw',
      `repos/${r.owner}/${r.name}/contents/${pathUrl(path)}?ref=${encodeURIComponent(ref)}`,
    ])
  } catch {
    return undefined
  }
}

async function settle<T>(p: Promise<T>, name: string, unavailable: string[], fallback: T): Promise<T> {
  try {
    return await p
  } catch {
    unavailable.push(name)
    return fallback
  }
}

/**
 * Gather everything the overview reads. `pr` already carries the review diff
 * and base analysis; everything else is fetched here, in parallel.
 */
export async function gatherOverviewContext(
  pr: PrContext,
  opts: { handle: string; resolver: BaseResolver; triage?: TriageFinding[]; deep?: DeepFinding[] }
): Promise<OverviewContext> {
  const repo = repoOf(pr.url)
  const api = (path: string): Promise<string> =>
    runGh(['api', '--hostname', repo.host, '--paginate', '--jq', '.[]', `repos/${repo.owner}/${repo.name}/${path}`])
  const unavailable: string[] = []

  const files = diffFiles(pr.diff)
  const keys = selectKeyFiles(files)

  const [defaultBranch, viewJson, commitsJson, lineJson, commentsJson] = await Promise.all([
    opts.resolver.defaultBranch(pr.url).catch(() => undefined),
    settle(runGh(['pr', 'view', pr.url, '--json', 'isDraft,closingIssuesReferences,reviews']), 'reviews and linked issues', unavailable, '{}'),
    settle(runGh(['pr', 'view', pr.url, '--json', 'commits']), 'commits', unavailable, '{}'),
    settle(api(`pulls/${pr.number}/comments`), 'line comments', unavailable, ''),
    settle(api(`issues/${pr.number}/comments`), 'PR comments', unavailable, ''),
  ])
  const view = JSON.parse(viewJson) as RawOverviewView
  const comments = parseNdjson<RawUserComment>(commentsJson)

  const self = { owner: repo.owner, repo: repo.name, number: pr.number }
  const closing = (view.closingIssuesReferences ?? []).map((c) => ({
    owner: c.repository?.owner?.login ?? repo.owner,
    repo: c.repository?.name ?? repo.name,
    number: c.number,
  }))
  const stacked = defaultBranch !== undefined && pr.baseRefName !== defaultBranch
  const stackedOn = stacked ? (pr.base?.kind === 'polluted' && pr.base.basePr != null ? `#${pr.base.basePr}` : pr.baseRefName) : undefined

  const [issues, keyFiles, guides] = await Promise.all([
    Promise.all(
      linkedIssues(closing, pr.body, self).map(async (ref) => {
        try {
          const raw = JSON.parse(
            await runGh(['issue', 'view', String(ref.number), '-R', `${repo.host}/${ref.owner}/${ref.repo}`, '--json', 'title,body'])
          ) as { title?: string; body?: string }
          const label = ref.owner === repo.owner && ref.repo === repo.name ? `#${ref.number}` : `${ref.owner}/${ref.repo}#${ref.number}`
          return { ref: label, title: raw.title ?? '', body: raw.body ?? '' }
        } catch {
          unavailable.push(`issue ${ref.owner}/${ref.repo}#${ref.number}`)
          return null
        }
      })
    ).then((all) => all.filter((i): i is { ref: string; title: string; body: string } => i !== null)),
    Promise.all(
      keys.map(async (f): Promise<KeyFile> => {
        const [head, base] = await Promise.all([
          pr.headSha ? fileAt(pr.url, f.path, pr.headSha) : Promise.resolve(undefined),
          defaultBranch && f.status !== 'added' ? fileAt(pr.url, f.path, defaultBranch) : Promise.resolve(undefined),
        ])
        if ((head?.length ?? 0) > MAX_KEY_FILE_BYTES || (base?.length ?? 0) > MAX_KEY_FILE_BYTES) {
          return { path: f.path, skipped: `over ${kb(MAX_KEY_FILE_BYTES)}` }
        }
        if (head === undefined) return { path: f.path, skipped: 'could not be read at the head' }
        return { path: f.path, head, ...(base !== undefined ? { base } : {}) }
      })
    ),
    defaultBranch ? nearestGuides(pr.url, keys.map((k) => k.path), defaultBranch) : Promise.resolve([]),
  ])

  const allCommits = parsePrCommits(commitsJson)
  const own = pr.base?.kind === 'polluted' ? new Set(pr.base.own.map((c) => c.sha)) : null
  const commits = own ? allCommits.filter((c) => own.has(c.sha)) : allCommits

  return {
    pr,
    handle: opts.handle,
    defaultBranch,
    isDraft: view.isDraft === true,
    commits: commits.map((c) => c.subject),
    foreignCommits: allCommits.length - commits.length,
    issues,
    discussion: parseDiscussion({
      lineComments: parseNdjson<RawUserComment>(lineJson),
      comments,
      reviews: view.reviews ?? [],
      handle: opts.handle,
    }),
    changeset: changesetInfo(files, comments, stackedOn),
    keyFiles,
    guides,
    triage: opts.triage ?? [],
    deep: opts.deep ?? [],
    unavailable,
  }
}

/**
 * The nearest `CLAUDE.md` for each key file, on the default branch, at most
 * two distinct ones. Candidates are fetched once each and shared between files.
 */
async function nearestGuides(url: string, paths: string[], ref: string): Promise<{ path: string; text: string }[]> {
  const fetched = new Map<string, Promise<string | undefined>>()
  const load = (p: string): Promise<string | undefined> => {
    let hit = fetched.get(p)
    if (!hit) {
      hit = fileAt(url, p, ref)
      fetched.set(p, hit)
    }
    return hit
  }
  const nearest = await Promise.all(
    paths.map(async (p) => {
      const candidates = claudeMdCandidates(p)
      const texts = await Promise.all(candidates.map(load))
      const i = texts.findIndex((t) => t !== undefined)
      return i === -1 ? null : { path: candidates[i], text: texts[i] as string }
    })
  )
  const out: { path: string; text: string }[] = []
  for (const g of nearest) {
    if (g && !out.some((o) => o.path === g.path)) out.push({ path: g.path, text: cutAt(g.text, MAX_GUIDE_BYTES) })
  }
  return out.slice(0, 2)
}
