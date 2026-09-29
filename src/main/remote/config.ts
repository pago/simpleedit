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
import { REMOTE_DEFAULT_HOST } from './interfaces'

function defaults(): RemoteAccessConfig {
  return { enabled: false, host: REMOTE_DEFAULT_HOST, port: 0, sttModelPath: '', serveEnabled: false, servePort: 0 }
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
      // Shape only. Whether this host may actually be BOUND is decided at
      // bind time, not here: rewriting it on read silently and permanently
      // downgraded a Tailscale preference to loopback whenever Tailscale
      // happened to be down at boot — the next write persisted the downgrade,
      // so the choice was gone for good. Keep the preference; refuse the bind.
      host: typeof parsed.host === 'string' && parsed.host.length > 0 ? parsed.host : base.host,
      port: typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port >= 0 && parsed.port <= 65535
        ? parsed.port
        : base.port,
      // Shape only, like `host`: whether the file is actually there is decided
      // when dictation runs, not on read. A model on an unmounted volume must
      // not silently erase the preference on the next write.
      sttModelPath: typeof parsed.sttModelPath === 'string' ? parsed.sttModelPath : base.sttModelPath,
      serveEnabled: typeof parsed.serveEnabled === 'boolean' ? parsed.serveEnabled : base.serveEnabled,
      // A claim ticket for a mapping inside tailscaled, not a preference. A
      // corrupt value here would strand a real mapping, so it falls back to
      // "we own nothing" rather than to something plausible.
      servePort: typeof parsed.servePort === 'number' && Number.isInteger(parsed.servePort)
        && parsed.servePort >= 0 && parsed.servePort <= 65535
        ? parsed.servePort
        : base.servePort,
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
