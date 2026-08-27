/**
 * Persisted remote-access preferences. Mirrors `models/config.ts`: one JSON
 * blob under userData/config, try/catch reads returning defaults.
 *
 * `enabled` defaults to FALSE and is never flipped implicitly. Remote access
 * exposes `pty:spawn`, `fs:write`, `worktree:remove` and every git operation
 * to whoever holds the token, so it starts only when a person asks for it.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { RemoteAccessConfig } from '../../shared/ipc-types'

/**
 * Loopback, and an ephemeral port. Binding is always explicit — an implicit
 * `0.0.0.0` would put a shell on every interface the Mac has the moment the
 * toggle is flipped. The Tailscale interface is opted into by hand.
 */
export const REMOTE_DEFAULT_HOST = '127.0.0.1'

function defaults(): RemoteAccessConfig {
  return { enabled: false, host: REMOTE_DEFAULT_HOST, port: 0 }
}

function filePath(): string {
  const dir = join(app.getPath('userData'), 'config')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'remote.json')
}

function isConfig(value: unknown): value is Partial<RemoteAccessConfig> {
  return typeof value === 'object' && value !== null
}

export function getRemoteConfig(): RemoteAccessConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath(), 'utf8'))
    if (!isConfig(parsed)) return defaults()
    const base = defaults()
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : base.enabled,
      host: typeof parsed.host === 'string' && parsed.host.length > 0 ? parsed.host : base.host,
      port: typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port >= 0 && parsed.port <= 65535
        ? parsed.port
        : base.port,
    }
  } catch {
    return defaults()
  }
}

export function setRemoteConfig(next: RemoteAccessConfig): void {
  try {
    writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* a config that won't persist still governs this session */
  }
}
