/**
 * What the hosted OpenTunnel service actually does, through the provider and
 * the real SDK.
 *
 * `opentunnel.test.ts` drives a fake relay written from our understanding of
 * the SDK, so it can only confirm that understanding. This file checks it
 * against the service: that a withdrawal during certificate issuance aborts it
 * and deletes the half-made tunnel, that a published URL serves our loopback
 * port, that a close keeps the URL, and that a withdrawal really deletes the
 * tunnel.
 *
 * It creates a real tunnel on a third-party service and takes about a minute
 * (certificate issuance), so it is opt-in:
 *
 *     SIMPLEEDIT_OPENTUNNEL_CONTRACT=1 pnpm exec vitest run --project unit opentunnel-contract
 *
 * Whatever happens, `afterAll` deletes what it created.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'

const enabled = process.env.SIMPLEEDIT_OPENTUNNEL_CONTRACT === '1'

let root = ''
vi.mock('../../config-dir', () => ({
  configDir: (...sub: string[]) => {
    const dir = join(root, ...sub)
    mkdirSync(dir, { recursive: true })
    return dir
  },
}))

import { PROFILE, RELAY_API, getOpenTunnelStatus, openTunnel, openTunnelIdle, resetOpenTunnelForTests } from '../opentunnel'

const TOKEN = 'c'.repeat(64)

let server: Server
let port = 0
const seen: { host: string | undefined; peer: string | undefined; headers: IncomingHttpHeaders }[] = []

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out; last status ${JSON.stringify(getOpenTunnelStatus())}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** The first request through a fresh tunnel can race DNS and the relay; retry briefly. */
async function fetchThrough(url: string): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(10_000) })
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
  throw lastError
}

describe.skipIf(!enabled)('the hosted OpenTunnel service', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'se-opentunnel-contract-'))
    resetOpenTunnelForTests()
    server = createServer((req, res) => {
      seen.push({ host: req.headers.host, peer: req.socket.remoteAddress, headers: req.headers })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('simpleedit-contract')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    try {
      openTunnel.withdraw()
      await openTunnelIdle()
      // Belt and braces, independent of the code under test: whatever is
      // still on disk, full or half provisioned, is deleted on the relay.
      const dir = join(root, 'opentunnel', 'opentunnel', PROFILE)
      for (const file of ['tunnel.json', 'pending.json']) {
        if (!existsSync(join(dir, file))) continue
        const meta: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'))
        const id = typeof meta === 'object' && meta !== null && 'id' in meta ? String(meta.id) : ''
        const relayToken = readFileSync(join(dir, 'token'), 'utf8').trim()
        const response = await fetch(`${RELAY_API}/api/tunnel/${id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${relayToken}` },
        })
        console.warn(`[contract] cleanup deleted leftover tunnel ${id}: HTTP ${response.status}`)
      }
    } finally {
      server.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  // The SDK's own `remove` skips a tunnel whose certificate is still being
  // issued; the relay must answer 404 for it afterwards all the same.
  it('aborts a provisioning in flight and deletes the half-made tunnel on the relay', async () => {
    const identityDir = join(root, 'opentunnel', 'opentunnel', PROFILE)
    openTunnel.apply({ port, token: TOKEN })
    await waitFor(() => existsSync(join(identityDir, 'pending.json')), 60_000)
    const pending: unknown = JSON.parse(readFileSync(join(identityDir, 'pending.json'), 'utf8'))
    const id = typeof pending === 'object' && pending !== null && 'id' in pending ? String(pending.id) : ''
    const relayToken = readFileSync(join(identityDir, 'token'), 'utf8').trim()
    expect(id).not.toBe('')
    const before = await fetch(`${RELAY_API}/api/tunnel/${id}`, { headers: { authorization: `Bearer ${relayToken}` } })
    expect(before.status).toBe(200)

    openTunnel.withdraw()
    await openTunnelIdle()
    expect(getOpenTunnelStatus()).toMatchObject({ busy: false, error: null, active: false })
    const after = await fetch(`${RELAY_API}/api/tunnel/${id}`, { headers: { authorization: `Bearer ${relayToken}` } })
    expect(after.status).toBe(404)
    expect(existsSync(identityDir)).toBe(false)
  }, 120_000)

  it('publishes the loopback port, keeps the URL across a close, and deletes on withdraw', async () => {
    openTunnel.apply({ port, token: TOKEN })
    await waitFor(() => getOpenTunnelStatus().active, 150_000)
    const url = getOpenTunnelStatus().url!
    const origin = new URL(url).origin
    expect(url).toMatch(/^https:\/\/[0-9a-f]{16}\.[a-z0-9]+\.opentunnel\.xyz\/app\/\?k=c{64}$/)

    const response = await fetchThrough(`${origin}/probe`)
    expect(await response.text()).toBe('simpleedit-contract')
    // What the hardening rests on: visitors are loopback peers, and their own
    // Host arrives with no forwarded scheme added by the relay.
    expect(seen.at(-1)).toMatchObject({ host: new URL(url).host, peer: '127.0.0.1' })
    expect(seen.at(-1)?.headers['x-forwarded-proto']).toBeUndefined()

    openTunnel.apply(null)
    await openTunnelIdle()
    expect(getOpenTunnelStatus().active).toBe(false)

    const reconnectStarted = Date.now()
    openTunnel.apply({ port, token: TOKEN })
    await waitFor(() => getOpenTunnelStatus().active, 30_000)
    expect(getOpenTunnelStatus().url).toBe(url)
    expect(Date.now() - reconnectStarted).toBeLessThan(15_000)

    openTunnel.withdraw()
    await openTunnelIdle()
    expect(getOpenTunnelStatus().error).toBeNull()
    const { create, OpenTunnelStorage } = await import('@opentunnel/client')
    const client = create({ store: OpenTunnelStorage.xdg({ env: { XDG_DATA_HOME: join(root, 'opentunnel') } }) })
    expect(await client.tunnel.list()).toEqual([])
    await client.dispose()
    expect(existsSync(join(root, 'opentunnel', 'opentunnel', PROFILE))).toBe(false)
    await expect(fetch(`${origin}/probe`, { signal: AbortSignal.timeout(10_000) })).rejects.toThrow()
  }, 240_000)
})
