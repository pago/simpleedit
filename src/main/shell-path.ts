import { execFile, execFileSync } from 'child_process'
import { app } from 'electron'
import type { ClaudeEnv } from './claude-paths'

/**
 * macOS apps launched from Finder/Spotlight inherit a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — none of the user's shell additions
 * (asdf, homebrew, nvm, …) are visible. That breaks any subprocess that
 * needs to find binaries on PATH (the LSP server most prominently).
 *
 * Spawn the user's login shell once and copy its PATH into our env. No-op
 * on Windows and when running from a dev terminal (PATH already correct).
 */
export function inheritShellPath(): void {
  if (process.platform === 'win32') return
  if (!app.isPackaged) return

  const shell = process.env['SHELL']
  if (!shell) return

  try {
    const out = execFileSync(shell, ['-ilc', 'echo -n "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out) process.env['PATH'] = out
  } catch (err) {
    console.warn('[SimpleEdit] Failed to inherit shell PATH:', err)
  }
}

const CLAUDE_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME'] as const

function claudeEnvFrom(source: Record<string, string | undefined>): ClaudeEnv {
  const env: ClaudeEnv = {}
  for (const key of CLAUDE_ENV_KEYS) {
    const value = source[key]
    if (value) env[key] = value
  }
  return env
}

/** How long a failed login-shell read is trusted before the next call retries it. */
export const CLAUDE_ENV_RETRY_MS = 60_000

let claudeEnvCached: ClaudeEnv | null = null
let claudeEnvInflight: Promise<ClaudeEnv> | null = null
let claudeEnvFailedAt: number | null = null

/** Read the vars from a login shell; null on any failure (error, timeout, garbled output). */
function readClaudeEnvFromShell(shell: string): Promise<ClaudeEnv | null> {
  // A leading NUL fences off anything the profile prints before our values.
  const script = ["printf '\\0'", ...CLAUDE_ENV_KEYS.map((k) => `printf '%s\\0' "$${k}"`)].join('; ')
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', script], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      if (err) {
        console.warn('[SimpleEdit] Failed to read Claude env from login shell:', err)
        resolve(null)
        return
      }
      const fields = stdout.split('\0')
      const values = fields.slice(-CLAUDE_ENV_KEYS.length - 1, -1)
      if (values.length !== CLAUDE_ENV_KEYS.length) {
        resolve(null)
        return
      }
      resolve(claudeEnvFrom(Object.fromEntries(CLAUDE_ENV_KEYS.map((k, i) => [k, values[i]]))))
    })
  })
}

/**
 * The Claude-storage env vars as a spawned Claude session sees them. Sessions
 * run through `$SHELL -i -l -c` (`pty.ts`), so a `CLAUDE_CONFIG_DIR` exported
 * from the user's profile applies to the CLI but not to a Dock-launched main
 * process. A successful login-shell read is cached for good; a failed one
 * falls back to `process.env` and is retried after `CLAUDE_ENV_RETRY_MS`, so
 * one slow shell start doesn't pin the wrong config dir until restart.
 *
 * Skipped under E2E for the same reason `pty.ts` drops `-i -l` there: a
 * developer profile must not override the test's temp config dir.
 */
export function claudeShellEnv(): Promise<ClaudeEnv> {
  if (claudeEnvCached) return Promise.resolve(claudeEnvCached)
  if (claudeEnvInflight) return claudeEnvInflight
  const shell = process.env['SHELL']
  if (process.platform === 'win32' || process.env['SIMPLEEDIT_E2E'] === '1' || !shell) {
    claudeEnvCached = claudeEnvFrom(process.env)
    return Promise.resolve(claudeEnvCached)
  }
  if (claudeEnvFailedAt !== null && Date.now() - claudeEnvFailedAt < CLAUDE_ENV_RETRY_MS) {
    return Promise.resolve(claudeEnvFrom(process.env))
  }
  claudeEnvInflight = readClaudeEnvFromShell(shell).then((env) => {
    claudeEnvInflight = null
    if (env) {
      claudeEnvCached = env
      claudeEnvFailedAt = null
      return env
    }
    claudeEnvFailedAt = Date.now()
    return claudeEnvFrom(process.env)
  })
  return claudeEnvInflight
}

/** Test seam: forget the cached env and any recorded failure. */
export function _resetClaudeShellEnvForTests(): void {
  claudeEnvCached = null
  claudeEnvInflight = null
  claudeEnvFailedAt = null
}
