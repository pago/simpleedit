/**
 * #204: SimpleEdit started from inside a Claude Code session must not hand
 * that session's identity to the agents it launches — a `claude` that thinks
 * it is a child session never writes its transcript, so Resume later fails.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MAIN, launchEnv, spawnClaudeSession, createTempRepo, removeTempRepo } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

const PARENT_SESSION = {
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'parent-session-id',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent-messaging.sock',
  CLAUDE_PID: '4242',
  AI_AGENT: 'claude-code',
  GIT_EDITOR: 'true',
}

function readEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

test('an agent launched from a Claude Code-started app gets none of the parent session env', async () => {
  const repo = createTempRepo('simpleedit-agent-env-')
  const dump = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'simpleedit-agent-env-dump-')), 'env.txt')
  const app = await electron.launch({
    args: [MAIN, ...SANDBOX_ARGS],
    env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath, SIMPLEEDIT_FAKE_CLAUDE_ENV_DUMP: dump, ...PARENT_SESSION }),
  })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await spawnClaudeSession(window)

    await expect.poll(() => fs.existsSync(dump) && fs.readFileSync(dump, 'utf8').includes('PATH='), {
      timeout: 15_000,
    }).toBe(true)
    const env = readEnv(dump)
    for (const key of Object.keys(PARENT_SESSION)) expect(env, key).not.toHaveProperty(key)
    expect(env['CLAUDE_CONFIG_DIR']).toBeTruthy()
  } finally {
    await app.close()
    removeTempRepo(repo)
  }
})
