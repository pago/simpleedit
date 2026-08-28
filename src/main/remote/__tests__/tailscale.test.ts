import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  findTailscaleCli,
  findTailscaleCliSync,
  getTailscaleStatus,
  missingCliHint,
  parseStatusJson,
  unusableCliHint,
} from '../tailscale'

/**
 * A stand-in for the Tailscale CLI: a shell script driven by env vars, pointed
 * at through `SIMPLEEDIT_TAILSCALE_CLI`. The real `execFile` path runs, so a
 * mistake in how the process is spawned or its output read still shows up.
 */
let fixtures = ''
let stub = ''

function writeStub(body: string): void {
  writeFileSync(stub, `#!/bin/sh\n${body}\n`, 'utf8')
  chmodSync(stub, 0o755)
}

const REAL_STATUS = JSON.stringify({
  BackendState: 'Running',
  MagicDNSSuffix: 'tail050858.ts.net',
  CertDomains: ['infras-macbook-air.tail050858.ts.net'],
  Self: { DNSName: 'infras-macbook-air.tail050858.ts.net.' },
})

beforeEach(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'se-ts-'))
  stub = join(fixtures, 'tailscale')
  process.env.SIMPLEEDIT_TAILSCALE_CLI = stub
})

afterEach(() => {
  delete process.env.SIMPLEEDIT_TAILSCALE_CLI
  rmSync(fixtures, { recursive: true, force: true })
})

describe('findTailscaleCli', () => {
  it('uses the override when it exists', async () => {
    writeStub('exit 0')
    expect(await findTailscaleCli()).toBe(stub)
    expect(findTailscaleCliSync()).toBe(stub)
  })

  it('reports nothing rather than falling through when the override is wrong', async () => {
    process.env.SIMPLEEDIT_TAILSCALE_CLI = join(fixtures, 'missing')
    expect(await findTailscaleCli()).toBeNull()
    expect(findTailscaleCliSync()).toBeNull()
  })
})

describe('parseStatusJson', () => {
  it('strips the trailing dot from the MagicDNS name', () => {
    expect(parseStatusJson(REAL_STATUS)?.dnsName).toBe('infras-macbook-air.tail050858.ts.net')
  })

  it('returns null rather than throwing on output that is not JSON', () => {
    expect(parseStatusJson('failed to connect to local tailscaled')).toBeNull()
  })

  it('treats a missing CertDomains as no certificates, not as a parse failure', () => {
    const parsed = parseStatusJson(JSON.stringify({ BackendState: 'Running' }))
    expect(parsed).not.toBeNull()
    expect(parsed?.certDomains).toEqual([])
  })
})

describe('getTailscaleStatus', () => {
  it('reports a running node with certificates as ready', async () => {
    writeStub(`cat <<'JSON'\n${REAL_STATUS}\nJSON`)
    const status = await getTailscaleStatus()
    expect(status.cli).toBe(stub)
    expect(status.backendState).toBe('Running')
    expect(status.dnsName).toBe('infras-macbook-air.tail050858.ts.net')
    expect(status.magicDnsSuffix).toBe('tail050858.ts.net')
    expect(status.httpsReady).toBe(true)
    expect(status.hint).toBeNull()
  })

  it('says HTTPS is missing when no certificate covers this node', async () => {
    const noCerts = JSON.stringify({
      BackendState: 'Running',
      MagicDNSSuffix: 'tail050858.ts.net',
      CertDomains: null,
      Self: { DNSName: 'infras-macbook-air.tail050858.ts.net.' },
    })
    writeStub(`cat <<'JSON'\n${noCerts}\nJSON`)
    const status = await getTailscaleStatus()
    expect(status.httpsReady).toBe(false)
    expect(status.hint).toMatch(/HTTPS certificates are not issued/)
  })

  it('says Tailscale is not connected rather than reporting a node', async () => {
    writeStub(`echo '{"BackendState":"NeedsLogin"}'`)
    const status = await getTailscaleStatus()
    expect(status.httpsReady).toBe(false)
    expect(status.hint).toMatch(/not connected \(NeedsLogin\)/)
  })

  it('names the CLI when it is present and will not answer', async () => {
    writeStub('echo "failed to connect to local tailscaled" >&2\nexit 1')
    const status = await getTailscaleStatus()
    expect(status.cli).toBe(stub)
    expect(status.backendState).toBeNull()
    expect(status.hint).toContain('did not answer')
    expect(status.hint).toContain('failed to connect to local tailscaled')
  })

  it('explains the missing CLI instead of failing silently', async () => {
    process.env.SIMPLEEDIT_TAILSCALE_CLI = join(fixtures, 'missing')
    const status = await getTailscaleStatus()
    expect(status.cli).toBeNull()
    expect(status.hint).toMatch(/No tailscale command was found/)
  })
})

describe('the Mac App Store build', () => {
  // The bundle path exists for that build too, so probing for the file is not
  // enough — and the resulting failure has a cause the user can act on, which
  // "did not answer" would hide.
  it('is named as the cause when no CLI was found', () => {
    expect(missingCliHint(true)).toMatch(/Mac App Store build .* is sandboxed/)
    expect(missingCliHint(false)).toMatch(/No tailscale command was found/)
  })

  it('is named as the cause when the CLI is present and silent', () => {
    expect(unusableCliHint('/Applications/Tailscale.app/Contents/MacOS/Tailscale', true, 'boom'))
      .toMatch(/Mac App Store build/)
    expect(unusableCliHint('/opt/homebrew/bin/tailscale', false, 'boom'))
      .toBe('/opt/homebrew/bin/tailscale did not answer: boom')
  })
})
