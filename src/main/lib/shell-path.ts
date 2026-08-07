import { execFile } from 'child_process'

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env['COMSPEC'] ?? 'cmd.exe'
  }
  return process.env['SHELL'] ?? '/bin/zsh'
}

/** Successful resolutions only — a binary's path doesn't move under us. */
const cachedPaths = new Map<string, string>()
/** When each failed lookup happened, so a miss is retried rather than final. */
const missedAt = new Map<string, number>()
const resolvePromises = new Map<string, Promise<string | null>>()

/**
 * How long a "not installed" answer stands before we look again. A permanent
 * negative cache would mean installing an agent CLI while SimpleEdit is running
 * leaves it invisible — its UI absent, its models empty — until a restart.
 * Re-probing costs one login shell, so a short window is plenty.
 */
const MISS_TTL_MS = 30_000

export type AgentExecutable = 'claude' | 'codex'

export function resolveExecutable(name: AgentExecutable): Promise<string | null> {
  const hit = cachedPaths.get(name)
  if (hit) return Promise.resolve(hit)
  const pending = resolvePromises.get(name)
  if (pending) return pending
  const missed = missedAt.get(name)
  if (missed !== undefined && Date.now() - missed < MISS_TTL_MS) return Promise.resolve(null)
  if (process.platform === 'win32') return Promise.resolve(name)

  // Register the in-flight promise BEFORE starting the lookup. Doing it after
  // would race a callback that completes synchronously: the handler's
  // `resolvePromises.delete` would run first and the later `set` would strand a
  // resolved promise in the map, pinning every future caller to this result.
  let settle: (value: string | null) => void = () => {}
  const promise = new Promise<string | null>((resolve) => { settle = resolve })
  resolvePromises.set(name, promise)

  const shell = defaultShell()
  execFile(shell, ['-i', '-l', '-c', `command -v ${name}`], (err, stdout) => {
    const path = stdout.trim()
    const result = !err && path ? path : null
    if (result) {
      cachedPaths.set(name, result)
      missedAt.delete(name)
    } else {
      missedAt.set(name, Date.now())
    }
    resolvePromises.delete(name)
    settle(result)
  })
  return promise
}

/** Test seam: forget everything resolved so far. */
export function resetExecutableCache(): void {
  cachedPaths.clear()
  missedAt.clear()
  resolvePromises.clear()
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
