import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

interface Spawn {
  file: string
  args: string[]
  env: Record<string, string>
}
const spawns: Spawn[] = []

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], opts: { env: Record<string, string> }) => {
    spawns.push({ file, args, env: opts.env })
    return { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: () => {}, onExit: () => {} }
  },
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', getPath: () => tmpdir() },
}))

let configDir = ''
let configDirKnown = true
vi.mock('../shell-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shell-path')>()),
  claudeShellEnvIfKnown: () => Promise.resolve(configDirKnown ? { CLAUDE_CONFIG_DIR: configDir } : null),
}))

import type { RemoteClient } from '../client-hub'
import { killAllTerminals, spawnAgentTerminalForProvider, spawnTerminal } from '../pty'
import { claudeProjectDirName } from '../claude-paths'

const hub: RemoteClient = { id: 1, send: vi.fn(), isDestroyed: () => false }
const PARENT = {
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'parent-session',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock',
  AI_AGENT: 'claude-code',
}
const SRC = 'abcdef01-2345-6789-abcd-ef0123456789'

let launchDir = ''
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  spawns.length = 0
  for (const [key, value] of Object.entries({ ...PARENT, CLAUDE_CONFIG_DIR: '/kept/config' })) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  configDir = mkdtempSync(join(tmpdir(), 'simpleedit-pty-env-config-'))
  mkdirSync(join(configDir, 'projects'))
  configDirKnown = true
  launchDir = realpathSync(mkdtempSync(join(tmpdir(), 'simpleedit-pty-env-cwd-')))
})

afterEach(() => {
  killAllTerminals()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(configDir, { recursive: true, force: true })
  rmSync(launchDir, { recursive: true, force: true })
})

function expectScrubbed(env: Record<string, string>): void {
  for (const key of Object.keys(PARENT)) expect(env).not.toHaveProperty(key)
  expect(env['CLAUDE_CONFIG_DIR']).toBe('/kept/config')
}

function writeTranscript(sessionId: string): void {
  const dir = join(configDir, 'projects', claudeProjectDirName(launchDir))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{}\n')
}

describe('PTY env', () => {
  it('a plain terminal does not inherit the parent Claude Code session', () => {
    spawnTerminal({ id: 'term-env', worktreePath: launchDir }, hub, '1')
    expect(spawns).toHaveLength(1)
    expectScrubbed(spawns[0]!.env)
  })

  it('an agent terminal does not inherit the parent Claude Code session', async () => {
    await spawnAgentTerminalForProvider(
      { id: 'agent-env', worktreePath: launchDir, target: { provider: 'claude' } },
      hub,
      '1',
    )
    expect(spawns).toHaveLength(1)
    expectScrubbed(spawns[0]!.env)
  })
})

describe('Claude resume preflight', () => {
  it('refuses a resume whose transcript was never written, before spawning', async () => {
    await expect(
      spawnAgentTerminalForProvider(
        { id: 'agent-resume-missing', worktreePath: launchDir, target: { provider: 'claude' }, resumeSessionId: SRC },
        hub,
        '1',
      ),
    ).rejects.toThrow(/No saved conversation for this session/)
    expect(spawns).toHaveLength(0)
  })

  it('refuses a fork whose source transcript is missing', async () => {
    await expect(
      spawnAgentTerminalForProvider(
        {
          id: 'agent-fork-missing',
          worktreePath: launchDir,
          target: { provider: 'claude' },
          resumeSessionId: SRC,
          forkSession: true,
        },
        hub,
        '1',
      ),
    ).rejects.toThrow(/No saved conversation/)
    expect(spawns).toHaveLength(0)
  })

  it('resumes when the transcript exists under the launch dir', async () => {
    writeTranscript(SRC)
    await spawnAgentTerminalForProvider(
      { id: 'agent-resume-ok', worktreePath: launchDir, target: { provider: 'claude' }, resumeSessionId: SRC },
      hub,
      '1',
    )
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.args.join(' ')).toContain(`--resume ${SRC}`)
  })

  it('resumes when the transcript sits under some other project key', async () => {
    const dir = join(configDir, 'projects', 'some-other-key')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${SRC}.jsonl`), '{}\n')
    await spawnAgentTerminalForProvider(
      { id: 'agent-resume-elsewhere', worktreePath: launchDir, target: { provider: 'claude' }, resumeSessionId: SRC },
      hub,
      '1',
    )
    expect(spawns).toHaveLength(1)
  })

  it('allows the resume when the config dir is only a fallback guess', async () => {
    configDirKnown = false
    await spawnAgentTerminalForProvider(
      { id: 'agent-resume-unknown', worktreePath: launchDir, target: { provider: 'claude' }, resumeSessionId: SRC },
      hub,
      '1',
    )
    expect(spawns).toHaveLength(1)
  })

  it('allows the resume when the config dir has no projects dir', async () => {
    rmSync(join(configDir, 'projects'), { recursive: true })
    await spawnAgentTerminalForProvider(
      { id: 'agent-resume-no-projects', worktreePath: launchDir, target: { provider: 'claude' }, resumeSessionId: SRC },
      hub,
      '1',
    )
    expect(spawns).toHaveLength(1)
  })

  it('a fresh launch is never checked', async () => {
    await spawnAgentTerminalForProvider(
      { id: 'agent-fresh', worktreePath: launchDir, target: { provider: 'claude' } },
      hub,
      '1',
    )
    expect(spawns).toHaveLength(1)
  })
})
