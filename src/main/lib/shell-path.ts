import { execFile } from 'child_process'

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env['COMSPEC'] ?? 'cmd.exe'
  }
  return process.env['SHELL'] ?? '/bin/zsh'
}

let cachedClaudePath: string | null = null
let resolvePromise: Promise<string> | null = null

/**
 * Resolve the full path to the `claude` binary by running `which claude` inside
 * an interactive login shell.  This ensures ~/.zprofile / ~/.zshrc are sourced
 * so claude is found regardless of how it was installed (nvm, homebrew, etc.).
 * Result is cached — subsequent calls return immediately.
 */
export function resolveClaudePath(): Promise<string> {
  if (cachedClaudePath) return Promise.resolve(cachedClaudePath)
  if (resolvePromise) return resolvePromise

  if (process.platform === 'win32') {
    cachedClaudePath = 'claude'
    return Promise.resolve(cachedClaudePath)
  }

  const shell = defaultShell()
  resolvePromise = new Promise<string>((resolve) => {
    execFile(shell, ['-i', '-l', '-c', 'which claude'], (err, stdout) => {
      const path = stdout.trim()
      if (!err && path) {
        cachedClaudePath = path
        resolve(path)
      } else {
        // Fall back to bare name and let spawn fail with a clear error
        cachedClaudePath = 'claude'
        resolve('claude')
      }
    })
  })

  return resolvePromise
}
