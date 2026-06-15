import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseHookBody,
  matchWorktree,
  resolveBareRepo,
  registerSession,
  terminalForSession,
  unregisterTerminal,
} from '../cwd-tracker'
import type { WorktreeInfo } from '../../shared/ipc-types'

function wt(path: string, branch = 'b'): WorktreeInfo {
  return { path, branch, isMain: false, isCurrent: false }
}

describe('parseHookBody', () => {
  it('extracts session_id + cwd from a well-formed hook body', () => {
    expect(parseHookBody({ session_id: 'abc', cwd: '/x/y', hook_event_name: 'PostToolUse' })).toEqual({
      sessionId: 'abc',
      cwd: '/x/y',
    })
  })

  it('ignores extra fields (event kind, tool input, etc.)', () => {
    const body = {
      session_id: 's',
      cwd: '/p',
      tool_name: 'Bash',
      tool_input: { command: 'cd /q' },
    }
    expect(parseHookBody(body)).toEqual({ sessionId: 's', cwd: '/p' })
  })

  it('returns null when session_id is missing or empty', () => {
    expect(parseHookBody({ cwd: '/x' })).toBeNull()
    expect(parseHookBody({ session_id: '', cwd: '/x' })).toBeNull()
  })

  it('returns null when cwd is missing or empty', () => {
    expect(parseHookBody({ session_id: 's' })).toBeNull()
    expect(parseHookBody({ session_id: 's', cwd: '' })).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(parseHookBody(null)).toBeNull()
    expect(parseHookBody('string')).toBeNull()
    expect(parseHookBody(42)).toBeNull()
  })
})

describe('matchWorktree', () => {
  let root: string
  let real: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'se-cwd-'))
    // realpath because macOS tmpdir itself is a symlink (/var → /private/var).
    real = realpathSync(root)
    mkdirSync(join(real, 'main'))
    mkdirSync(join(real, 'main', 'src'))
    mkdirSync(join(real, 'feature'))
    mkdirSync(join(real, 'feature-x')) // sibling that must NOT match `feature`
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('matches an exact worktree path', () => {
    const worktrees = [wt(join(real, 'main')), wt(join(real, 'feature'))]
    expect(matchWorktree(join(real, 'main'), worktrees)).toBe(join(real, 'main'))
  })

  it('matches a nested cwd to its containing worktree', () => {
    const worktrees = [wt(join(real, 'main'))]
    expect(matchWorktree(join(real, 'main', 'src'), worktrees)).toBe(join(real, 'main'))
  })

  it('matches on path-segment boundaries (not string prefix)', () => {
    // cwd /…/feature-x must not match worktree /…/feature
    const worktrees = [wt(join(real, 'feature'))]
    expect(matchWorktree(join(real, 'feature-x'), worktrees)).toBeNull()
  })

  it('picks the deepest worktree when worktrees nest', () => {
    const worktrees = [wt(join(real, 'main')), wt(join(real, 'main', 'src'))]
    expect(matchWorktree(join(real, 'main', 'src'), worktrees)).toBe(join(real, 'main', 'src'))
  })

  it('returns null when cwd is outside every worktree', () => {
    const worktrees = [wt(join(real, 'main'))]
    expect(matchWorktree(join(real, 'feature'), worktrees)).toBeNull()
  })

  it('resolves symlinked cwd against real worktree paths (CLI symlink-resolves cwd)', () => {
    // Worktree registered by its real path; a symlink pointing into it should
    // still match once both sides are realpath'd.
    const linkParent = mkdtempSync(join(tmpdir(), 'se-cwd-link-'))
    const link = join(linkParent, 'link-to-main')
    symlinkSync(join(real, 'main'), link)
    try {
      const worktrees = [wt(join(real, 'main'))]
      expect(matchWorktree(join(link, 'src'), worktrees)).toBe(join(real, 'main'))
    } finally {
      rmSync(linkParent, { recursive: true, force: true })
    }
  })

  it('returns the original (non-realpathed) worktree path so it matches renderer state', () => {
    // Worktree path given via a symlink; the returned value is that symlink
    // path verbatim, not its realpath.
    const linkParent = mkdtempSync(join(tmpdir(), 'se-cwd-wt-'))
    const wtLink = join(linkParent, 'wt')
    symlinkSync(join(real, 'main'), wtLink)
    try {
      const worktrees = [wt(wtLink)]
      // cwd is the real path; should match and return the symlink path.
      expect(matchWorktree(join(real, 'main', 'src'), worktrees)).toBe(wtLink)
    } finally {
      rmSync(linkParent, { recursive: true, force: true })
    }
  })

  it('returns null for an empty worktree list', () => {
    expect(matchWorktree(join(real, 'main'), [])).toBeNull()
  })
})

describe('resolveBareRepo', () => {
  let root: string
  let real: string
  let proj: string
  let commonDir: string
  let worktreeDir: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'se-repo-'))
    real = realpathSync(root)
    proj = join(real, 'proj')
    mkdirSync(proj)
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', proj, ...args], { stdio: 'pipe' })
    }
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('config', 'commit.gpgsign', 'false') // ignore the runner's global signing config
    git('commit', '--allow-empty', '-q', '-m', 'init')
    worktreeDir = join(real, 'wt')
    git('worktree', 'add', '-q', worktreeDir, '-b', 'feat')
    commonDir = realpathSync(join(proj, '.git'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves the common git dir from inside a linked worktree', async () => {
    expect(await resolveBareRepo(worktreeDir)).toBe(commonDir)
  })

  it('resolves the common git dir from the main working tree', async () => {
    expect(await resolveBareRepo(proj)).toBe(commonDir)
  })

  it('returns null when cwd is not inside a git repo', async () => {
    expect(await resolveBareRepo(real)).toBeNull()
  })
})

describe('session → terminal registry', () => {
  it('round-trips a registered mapping', () => {
    registerSession('sess-1', 'term-1')
    expect(terminalForSession('sess-1')).toBe('term-1')
  })

  it('returns null for an unknown session', () => {
    expect(terminalForSession('nope')).toBeNull()
  })

  it('drops all mappings for a terminal on unregister', () => {
    registerSession('sess-a', 'term-x')
    registerSession('sess-b', 'term-x') // resume could re-key same terminal
    unregisterTerminal('term-x')
    expect(terminalForSession('sess-a')).toBeNull()
    expect(terminalForSession('sess-b')).toBeNull()
  })
})
