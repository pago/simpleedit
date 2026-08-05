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
      terminalId: null,
      cwd: '/x/y',
      filePath: null,
      eventName: 'PostToolUse',
      lastAssistantMessage: null,
      stopHookActive: false,
    })
  })

  it('ignores fields it does not use (Bash command, tool name, etc.)', () => {
    const body = {
      session_id: 's',
      cwd: '/p',
      tool_name: 'Bash',
      tool_input: { command: 'cd /q' },
    }
    expect(parseHookBody(body)).toEqual({
      sessionId: 's',
      terminalId: null,
      cwd: '/p',
      filePath: null,
      eventName: null,
      lastAssistantMessage: null,
      stopHookActive: false,
    })
  })

  it('surfaces an absolute file_path from a file tool (Read/Write/Edit)', () => {
    const body = {
      session_id: 's',
      cwd: '/repo/main',
      tool_name: 'Edit',
      tool_input: { file_path: '/other-repo/backend/src/app.ts', old_string: 'a', new_string: 'b' },
    }
    expect(parseHookBody(body)).toEqual({
      sessionId: 's',
      terminalId: null,
      cwd: '/repo/main',
      filePath: '/other-repo/backend/src/app.ts',
      eventName: null,
      lastAssistantMessage: null,
      stopHookActive: false,
    })
  })

  it('accepts Codex reporter identity and lifecycle metadata', () => {
    expect(parseHookBody({
      session_id: 'thr_123',
      simpleedit_terminal_id: 'agent-codex-1',
      cwd: '/repo/main',
      hook_event_name: 'PermissionRequest',
    })).toEqual({
      sessionId: 'thr_123', terminalId: 'agent-codex-1', cwd: '/repo/main', eventName: 'PermissionRequest', filePath: null,
    })
  })

  it('surfaces notebook_path (NotebookEdit) as the touched file', () => {
    const body = {
      session_id: 's',
      cwd: '/repo/main',
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: '/other-repo/analysis.ipynb' },
    }
    expect(parseHookBody(body)?.filePath).toBe('/other-repo/analysis.ipynb')
  })

  it('ignores a relative file_path (can only resolve absolute paths to a repo)', () => {
    const body = {
      session_id: 's',
      cwd: '/repo/main',
      tool_name: 'Read',
      tool_input: { file_path: 'src/app.ts' },
    }
    expect(parseHookBody(body)?.filePath).toBeNull()
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

  // Agent messaging rides on these three: the event kind selects the Stop path,
  // last_assistant_message is the reply channel, and stop_hook_active is what
  // stops a delivered turn from being re-blocked forever.
  it('surfaces the Stop fields used by agent messaging', () => {
    expect(
      parseHookBody({
        session_id: 's',
        cwd: '/p',
        hook_event_name: 'Stop',
        stop_hook_active: true,
        last_assistant_message: 'the answer',
      }),
    ).toEqual({
      sessionId: 's',
      cwd: '/p',
      filePath: null,
      eventName: 'Stop',
      lastAssistantMessage: 'the answer',
      stopHookActive: true,
    })
  })

  it('treats an absent stop_hook_active as false, not missing', () => {
    const signal = parseHookBody({ session_id: 's', cwd: '/p', hook_event_name: 'Stop' })
    expect(signal?.stopHookActive).toBe(false)
    expect(signal?.lastAssistantMessage).toBeNull()
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
