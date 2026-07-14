import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DiffFileEntry, WorktreeInfo } from '../../../shared/ipc-types'
import { formatBriefContext, assembleBriefContext } from '../session-brief'
import { sessionsStore, type Session } from '../../stores/sessions.svelte'
import { setProjectRoot, refreshWorktreesFor } from '../../stores/worktrees.svelte'

describe('formatBriefContext (pure)', () => {
  const base = { goal: null, branch: 'feat', worktreePath: '/repo/feat', changedFiles: [], touchedRepos: [] }

  it('includes the goal when present and omits the section when not', () => {
    expect(formatBriefContext({ ...base, goal: 'fix the reducer' })).toContain('## Original goal\nfix the reducer')
    expect(formatBriefContext(base)).not.toContain('## Original goal')
  })

  it('lists changed files by status, or says there are none', () => {
    const changedFiles: DiffFileEntry[] = [
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
    ]
    const out = formatBriefContext({ ...base, changedFiles })
    expect(out).toContain('Uncommitted changes (2 files):')
    expect(out).toContain('- [modified] src/a.ts')
    expect(out).toContain('- [added] src/b.ts')
    expect(formatBriefContext(base)).toContain('No uncommitted changes.')
  })

  it('always points at PLAN/PR and forbids re-reading the transcript', () => {
    const out = formatBriefContext(base)
    expect(out).toContain('PLAN.md')
    expect(out).toMatch(/do NOT re-read the previous session/i)
  })

  it('never embeds a diff body — only file names + status', () => {
    const out = formatBriefContext({ ...base, changedFiles: [{ path: 'src/a.ts', status: 'modified' }] })
    expect(out).not.toContain('@@')
    expect(out).not.toContain('+++')
  })

  it('shows the cross-repo section only when more than one repo was touched', () => {
    expect(formatBriefContext({ ...base, touchedRepos: ['/repo/a.git'] })).not.toContain('## Also worked across')
    expect(formatBriefContext({ ...base, touchedRepos: ['/repo/a.git', '/repo/b.git'] })).toContain(
      '## Also worked across',
    )
  })
})

describe('assembleBriefContext', () => {
  const PRIMARY = '/repo/primary.git'
  const FEAT = '/repo/primary/feat'
  const LISTS: Record<string, WorktreeInfo[]> = {
    [PRIMARY]: [{ path: FEAT, branch: 'feature-x', isMain: false, isCurrent: false }],
  }

  beforeEach(async () => {
    ;(window as unknown as { api: { invoke: unknown } }).api = {
      invoke: vi.fn((channel: string, arg?: unknown) => {
        if (channel === 'worktree:list') return Promise.resolve(LISTS[(arg as string) ?? PRIMARY] ?? [])
        if (channel === 'git:staging-files')
          return Promise.resolve([{ path: 'src/x.ts', status: 'modified' }] satisfies DiffFileEntry[])
        return Promise.resolve(undefined)
      }),
    }
    setProjectRoot(PRIMARY)
    await refreshWorktreesFor(PRIMARY)
    sessionsStore.reset()
  })

  it('pulls the goal from the seed prompt, resolves the branch, and lists staged files', async () => {
    const session: Session = {
      id: 's',
      kind: 'claude',
      label: 'Claude',
      launchDir: PRIMARY,
      worktreePath: FEAT,
      touchedWorktrees: [FEAT],
      seedPrompt: 'implement feature x',
    }
    const out = await assembleBriefContext(session)
    expect(out).toContain('implement feature x')
    expect(out).toContain('branch `feature-x`')
    expect(out).toContain('- [modified] src/x.ts')
  })

  it('degrades gracefully when git staging-files fails', async () => {
    ;(window as unknown as { api: { invoke: unknown } }).api = {
      invoke: vi.fn((channel: string) => {
        if (channel === 'git:staging-files') return Promise.reject(new Error('git boom'))
        return Promise.resolve([])
      }),
    }
    const session: Session = {
      id: 's',
      kind: 'claude',
      label: 'Claude',
      launchDir: PRIMARY,
      worktreePath: FEAT,
      touchedWorktrees: [FEAT],
    }
    const out = await assembleBriefContext(session)
    expect(out).toContain('No uncommitted changes.')
  })
})
