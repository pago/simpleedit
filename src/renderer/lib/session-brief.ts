/**
 * Assembles the CONTEXT half of a hand-off brief — the durable, cheap-to-gather
 * facts a successor session needs, so the human only has to type the DIRECTIVE
 * (what the new session should do). See plans/session-spawn.md §3.
 *
 * Hard invariant: this is POINTERS AND SUMMARIES, never file bodies or the
 * transcript. Re-embedding bulk would refill the fresh context we're escaping —
 * the whole point of a hand-off. So: the goal (persisted seed prompt), the
 * branch + a changed-FILE list (names + status, no diffs), the worktrees
 * touched, and pointers to PLAN.md / the open PR for what's left.
 */
import type { DiffFileEntry } from '../../shared/ipc-types'
import { type Session, touchedReposForSession } from '../stores/sessions.svelte'
import { worktreeList } from '../stores/worktrees.svelte'

export interface BriefContext {
  goal: string | null
  branch: string | null
  worktreePath: string
  changedFiles: DiffFileEntry[]
  /** Distinct repos this session worked across, most-recent first. */
  touchedRepos: string[]
}

/** Pure formatter — turns gathered facts into the editable context block. */
export function formatBriefContext(ctx: BriefContext): string {
  const lines: string[] = []

  if (ctx.goal && ctx.goal.trim()) {
    lines.push('## Original goal', ctx.goal.trim(), '')
  }

  lines.push('## Current state')
  lines.push(
    ctx.branch
      ? `Working in \`${ctx.worktreePath}\` on branch \`${ctx.branch}\`.`
      : `Working in \`${ctx.worktreePath}\`.`,
  )
  if (ctx.changedFiles.length > 0) {
    lines.push(`Uncommitted changes (${ctx.changedFiles.length} file${ctx.changedFiles.length === 1 ? '' : 's'}):`)
    for (const f of ctx.changedFiles) lines.push(`- [${f.status}] ${f.path}`)
  } else {
    lines.push('No uncommitted changes.')
  }

  if (ctx.touchedRepos.length > 1) {
    lines.push('', '## Also worked across', ...ctx.touchedRepos.map((r) => `- ${r}`))
  }

  lines.push(
    '',
    '## What\'s left',
    'Check `PLAN.md` and any open PR for the remaining work and decisions made so far. Start from the code state above — do NOT re-read the previous session\'s transcript.',
  )

  return lines.join('\n')
}

/**
 * Gather the brief context for a session. Best-effort: a failed `git`
 * staging-files call degrades to an empty changed-files list rather than
 * blocking the hand-off.
 */
export async function assembleBriefContext(session: Session): Promise<string> {
  const branch = worktreeList().find((w) => w.path === session.worktreePath)?.branch ?? null

  let changedFiles: DiffFileEntry[] = []
  try {
    changedFiles = await window.api.invoke('git:staging-files', session.worktreePath)
  } catch {
    changedFiles = []
  }

  return formatBriefContext({
    goal: session.seedPrompt ?? null,
    branch,
    worktreePath: session.worktreePath,
    changedFiles,
    touchedRepos: touchedReposForSession(session),
  })
}
