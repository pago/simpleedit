import { execFileSync } from 'child_process'
import { app } from 'electron'

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
