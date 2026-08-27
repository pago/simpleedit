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
import { REMOTE_DEFAULT_HOST, isAllowedBindHost } from './interfaces'

function defaults(): RemoteAccessConfig {
  return { enabled: false, host: REMOTE_DEFAULT_HOST, port: 0 }
}

function filePath(): string {
  // E2E turns remote access on, and userData is shared with the engineer's own
  // dev build — a test must never leave a server enabled in it.
  if (process.env.SIMPLEEDIT_E2E_REMOTE_CONFIG) return process.env.SIMPLEEDIT_E2E_REMOTE_CONFIG
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
      // Re-validated on READ, not just on write. A stored host is untrusted
      // input by the time it comes back — the file is editable, and an address
      // that was legitimate when chosen may no longer exist (Tailscale down at
      // boot). Falling back to loopback fails closed: the wrong outcome is a
      // server nobody can reach, never one everybody can.
      host: typeof parsed.host === 'string' && isAllowedBindHost(parsed.host) ? parsed.host : base.host,
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
