import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../config-dir', () => ({ configDir: () => { throw new Error('the test file is set by env') } }))

import { getRemoteConfig, setRemoteConfig } from '../config'

let dir: string
let file: string

function store(raw: unknown): void {
  writeFileSync(file, JSON.stringify(raw), 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remote-config-'))
  file = join(dir, 'remote.json')
  vi.stubEnv('SIMPLEEDIT_E2E_REMOTE_CONFIG', file)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('remote config exposure', () => {
  it('defaults to off with no file', () => {
    expect(getRemoteConfig().exposure).toBe('off')
  })

  it('migrates a Serve opt-in from before exposure existed', () => {
    store({ enabled: true, host: '127.0.0.1', port: 0, sttModelPath: '', serveEnabled: true, servePort: 41234 })
    const config = getRemoteConfig()
    expect(config.exposure).toBe('tailscale-serve')
    // The crash-recovery claim is Tailscale's, and must survive the migration.
    expect(config.servePort).toBe(41234)
  })

  it('migrates a Serve opt-out, and a file that never had the field, to off', () => {
    store({ enabled: true, serveEnabled: false })
    expect(getRemoteConfig().exposure).toBe('off')
    store({ enabled: true })
    expect(getRemoteConfig().exposure).toBe('off')
  })

  it('lets a stored exposure win over a stale serveEnabled', () => {
    store({ exposure: 'off', serveEnabled: true })
    expect(getRemoteConfig().exposure).toBe('off')
  })

  it('reads an exposure this build does not know as off, never as an opt-in', () => {
    store({ exposure: 'something-newer', serveEnabled: true })
    expect(getRemoteConfig().exposure).toBe('off')
  })

  it('writes the migrated shape back without the legacy field', () => {
    store({ enabled: true, serveEnabled: true })
    setRemoteConfig(getRemoteConfig())
    const written: unknown = JSON.parse(readFileSync(file, 'utf8'))
    expect(written).toMatchObject({ exposure: 'tailscale-serve' })
    expect(written).not.toHaveProperty('serveEnabled')
  })
})

describe('remote config OpenTunnel acknowledgement', () => {
  it('reads OpenTunnel back as a known exposure', () => {
    store({ exposure: 'opentunnel', openTunnelAcknowledged: true })
    expect(getRemoteConfig()).toMatchObject({ exposure: 'opentunnel', openTunnelAcknowledged: true })
  })

  it('counts only a literal true as acknowledged', () => {
    expect(getRemoteConfig().openTunnelAcknowledged).toBe(false)
    store({ openTunnelAcknowledged: 'yes' })
    expect(getRemoteConfig().openTunnelAcknowledged).toBe(false)
  })
})
