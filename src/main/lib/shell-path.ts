import { execFile } from 'child_process'

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env['COMSPEC'] ?? 'cmd.exe'
  }
  return process.env['SHELL'] ?? '/bin/zsh'
}

const cachedPaths = new Map<string, string | null>()
const resolvePromises = new Map<string, Promise<string | null>>()

export type AgentExecutable = 'claude' | 'codex'

export function resolveExecutable(name: AgentExecutable): Promise<string | null> {
  if (cachedPaths.has(name)) return Promise.resolve(cachedPaths.get(name) ?? null)
  const pending = resolvePromises.get(name)
  if (pending) return pending
  if (process.platform === 'win32') return Promise.resolve(name)

  const shell = defaultShell()
  const promise = new Promise<string | null>((resolve) => {
    execFile(shell, ['-i', '-l', '-c', `command -v ${name}`], (err, stdout) => {
      const path = stdout.trim()
      const result = !err && path ? path : null
      cachedPaths.set(name, result)
      resolvePromises.delete(name)
      resolve(result)
    })
  })
  resolvePromises.set(name, promise)
  return promise
}

export async function isExecutableAvailable(name: AgentExecutable): Promise<boolean> {
  return (await resolveExecutable(name)) !== null
}

/**
 * Resolve the full path to the `claude` binary by running `which claude` inside
 * an interactive login shell.  This ensures ~/.zprofile / ~/.zshrc are sourced
 * so claude is found regardless of how it was installed (nvm, homebrew, etc.).
 * Result is cached — subsequent calls return immediately.
 */
export function resolveClaudePath(): Promise<string> {
  return resolveExecutable('claude').then((path) => path ?? 'claude')
}

export function resolveCodexPath(): Promise<string> {
  return resolveExecutable('codex').then((path) => path ?? 'codex')
}
