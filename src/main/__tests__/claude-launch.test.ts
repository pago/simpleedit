import { describe, it, expect, vi } from 'vitest'

// claude.ts imports `electron` (for the packaged MCP-server path); stub it since
// buildLaunch without a bridge never touches `app`.
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app' } }))

import { claudeProvider } from '../agents/claude'

const base = { terminalId: 'term-1', worktreePath: '/repo/main' }
const SRC = 'abcdef01-2345-6789-abcd-ef0123456789'

describe('claudeProvider.buildLaunch — session-id branching', () => {
  it('fresh spawn: pins a new --session-id, no --resume/--fork-session', () => {
    const plan = claudeProvider.buildLaunch({ ...base })
    expect(plan.args).toEqual(expect.arrayContaining(['--session-id', plan.sessionId]))
    expect(plan.args).not.toContain('--resume')
    expect(plan.args).not.toContain('--fork-session')
  })

  it('resume: reuses the source id with --resume alone (continue semantics)', () => {
    const plan = claudeProvider.buildLaunch({ ...base, resumeSessionId: SRC })
    expect(plan.sessionId).toBe(SRC)
    expect(plan.args).toEqual(expect.arrayContaining(['--resume', SRC]))
    expect(plan.args).not.toContain('--session-id')
    expect(plan.args).not.toContain('--fork-session')
  })

  it('fork: mints a FRESH id AND adds --fork-session (never appends to source)', () => {
    const plan = claudeProvider.buildLaunch({ ...base, resumeSessionId: SRC, forkSession: true })
    // The critical gotcha: a fork is a new id + --fork-session, distinct from
    // the resume/append branch. Reusing the source id would corrupt the parent.
    expect(plan.sessionId).not.toBe(SRC)
    expect(plan.args).toEqual(expect.arrayContaining(['--session-id', plan.sessionId, '--resume', SRC, '--fork-session']))
  })

  it('forkSession without a resume id falls back to a plain fresh spawn', () => {
    const plan = claudeProvider.buildLaunch({ ...base, forkSession: true })
    expect(plan.args).toEqual(expect.arrayContaining(['--session-id', plan.sessionId]))
    expect(plan.args).not.toContain('--fork-session')
    expect(plan.args).not.toContain('--resume')
  })
})
