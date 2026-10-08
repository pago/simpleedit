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

let claudeEnvPromise: Promise<ClaudeEnv> | null = null

/**
 * The Claude-storage env vars as a spawned Claude session sees them. Sessions
 * run through `$SHELL -i -l -c` (`pty.ts`), so a `CLAUDE_CONFIG_DIR` exported
 * from the user's profile applies to the CLI but not to a Dock-launched main
 * process. Read once from a login shell; on any failure fall back to
 * `process.env`.
 *
 * Skipped under E2E for the same reason `pty.ts` drops `-i -l` there: a
 * developer profile must not override the test's temp config dir.
 */
export function claudeShellEnv(): Promise<ClaudeEnv> {
  if (claudeEnvPromise) return claudeEnvPromise
  const shell = process.env['SHELL']
  if (process.platform === 'win32' || process.env['SIMPLEEDIT_E2E'] === '1' || !shell) {
    claudeEnvPromise = Promise.resolve(claudeEnvFrom(process.env))
    return claudeEnvPromise
  }
  // A leading NUL fences off anything the profile prints before our values.
  const script = ["printf '\\0'", ...CLAUDE_ENV_KEYS.map((k) => `printf '%s\\0' "$${k}"`)].join('; ')
  claudeEnvPromise = new Promise((resolve) => {
    execFile(shell, ['-ilc', script], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      if (err) {
        console.warn('[SimpleEdit] Failed to read Claude env from login shell:', err)
        resolve(claudeEnvFrom(process.env))
        return
      }
      const fields = stdout.split('\0')
      const values = fields.slice(-CLAUDE_ENV_KEYS.length - 1, -1)
      if (values.length !== CLAUDE_ENV_KEYS.length) {
        resolve(claudeEnvFrom(process.env))
        return
      }
      resolve(claudeEnvFrom(Object.fromEntries(CLAUDE_ENV_KEYS.map((k, i) => [k, values[i]]))))
    })
  })
  return claudeEnvPromise
}
