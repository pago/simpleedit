import { describe, it, expect } from 'vitest'
import { agentEnv } from '../agent-env'

const PARENT_SESSION = {
  AI_AGENT: 'claude-code',
  CLAUDECODE: '1',
  CLAUDE_PID: '4242',
  CLAUDE_EFFORT: 'high',
  CLAUDE_SESSION_ID: 'parent',
  CLAUDE_CODE_SESSION_ID: 'parent',
  CLAUDE_CODE_SESSION_KIND: 'interactive',
  CLAUDE_CODE_SESSION_NAME: 'parent',
  CLAUDE_CODE_SESSION_ORIGIN: 'cli',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude',
  CLAUDE_CODE_SSE_PORT: '12345',
  CLAUDE_CODE_TOOL_USE_ID: 'toolu_1',
  CLAUDE_CODE_SPAWNED_BY_SERVER: '1',
  CLAUDE_CODE_SPAWN_TIMESTAMP_MS: '1700000000000',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
  GIT_EDITOR: 'true',
}

const USER_CONFIG = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/me',
  CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
  CLAUDE_CODE_PROJECT_DIR_NAME: 'work',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  CLAUDE_CLIENT_PRESENCE_FILE: '/tmp/presence',
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
  CLAUDE_CODE_IDE_SKIP_VALID_CHECK: '1',
  CLAUDE_CODE_IDE_HOST_OVERRIDE: 'localhost',
  ANTHROPIC_API_KEY: 'sk-ant',
  ANTHROPIC_BASE_URL: 'https://proxy.example',
  CODEX_HOME: '/Users/me/.codex',
  OPENCODE_CONFIG: '/Users/me/.opencode.json',
}

describe('agentEnv', () => {
  it('drops every inherited Claude Code session variable', () => {
    const env = agentEnv({ ...USER_CONFIG, ...PARENT_SESSION })
    for (const key of Object.keys(PARENT_SESSION)) expect(env).not.toHaveProperty(key)
  })

  it('keeps user configuration and everything else intact', () => {
    expect(agentEnv({ ...USER_CONFIG, ...PARENT_SESSION })).toEqual(USER_CONFIG)
  })

  it('does not mutate its input', () => {
    const base = { ...USER_CONFIG, ...PARENT_SESSION }
    agentEnv(base)
    expect(base).toEqual({ ...USER_CONFIG, ...PARENT_SESSION })
  })

  it("keeps GIT_EDITOR=true when there is no Claude Code parent, and a user's own editor always", () => {
    expect(agentEnv({ PATH: '/bin', GIT_EDITOR: 'true' })).toEqual({ PATH: '/bin', GIT_EDITOR: 'true' })
    expect(agentEnv({ CLAUDECODE: '1', GIT_EDITOR: 'vim' })).toEqual({ GIT_EDITOR: 'vim' })
  })

  it('drops undefined values', () => {
    expect(agentEnv({ PATH: '/bin', UNSET: undefined })).toEqual({ PATH: '/bin' })
  })
})
