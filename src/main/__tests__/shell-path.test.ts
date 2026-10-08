import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const execFile = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ execFile, execFileSync: vi.fn() }))
vi.mock('electron', () => ({ app: {} }))

import { _resetClaudeShellEnvForTests, CLAUDE_ENV_RETRY_MS, claudeShellEnv } from '../shell-path'

type Callback = (err: Error | null, stdout: string) => void

function shellReplies(stdout: string | null): void {
  execFile.mockImplementationOnce((_shell: string, _args: string[], _opts: unknown, cb: Callback) => {
    cb(stdout === null ? new Error('timed out') : null, stdout ?? '')
  })
}

let now = 1_000_000
const saved = { ...process.env }
beforeEach(() => {
  _resetClaudeShellEnvForTests()
  execFile.mockReset()
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  process.env['SHELL'] = '/bin/zsh'
  delete process.env['SIMPLEEDIT_E2E']
  process.env['CLAUDE_CONFIG_DIR'] = '/from/process'
  delete process.env['CLAUDE_CODE_PROJECT_DIR_NAME']
})
afterEach(() => {
  vi.restoreAllMocks()
  process.env = { ...saved }
})

describe.skipIf(process.platform === 'win32')('claudeShellEnv', () => {
  it('caches a successful login-shell read', async () => {
    shellReplies('profile noise\0/from/shell\0\0')
    expect(await claudeShellEnv()).toEqual({ CLAUDE_CONFIG_DIR: '/from/shell' })
    now += CLAUDE_ENV_RETRY_MS * 10
    expect(await claudeShellEnv()).toEqual({ CLAUDE_CONFIG_DIR: '/from/shell' })
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('falls back to process.env on failure and retries only after the retry window', async () => {
    shellReplies(null)
    expect(await claudeShellEnv()).toEqual({ CLAUDE_CONFIG_DIR: '/from/process' })
    expect(await claudeShellEnv()).toEqual({ CLAUDE_CONFIG_DIR: '/from/process' })
    expect(execFile).toHaveBeenCalledTimes(1)

    now += CLAUDE_ENV_RETRY_MS + 1
    shellReplies('\0/from/shell\0\0')
    expect(await claudeShellEnv()).toEqual({ CLAUDE_CONFIG_DIR: '/from/shell' })
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('treats garbled output as a failure, not a result', async () => {
    shellReplies('no separators at all')
    expect(await claudeShellEnv()).toEqual({ CLAUDE_CONFIG_DIR: '/from/process' })
    now += CLAUDE_ENV_RETRY_MS + 1
    shellReplies('\0/from/shell\0name_1\0')
    expect(await claudeShellEnv()).toEqual({ CLAUDE_CONFIG_DIR: '/from/shell', CLAUDE_CODE_PROJECT_DIR_NAME: 'name_1' })
  })

  it('coalesces concurrent reads', async () => {
    shellReplies('\0/from/shell\0\0')
    const [a, b] = await Promise.all([claudeShellEnv(), claudeShellEnv()])
    expect(a).toEqual(b)
    expect(execFile).toHaveBeenCalledTimes(1)
  })
})
