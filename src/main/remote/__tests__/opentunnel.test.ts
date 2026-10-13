import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  OpenTunnelStorage,
  type OpenTunnelClientEvent,
  type OpenTunnelIdentity,
  type OpenTunnelRoutes,
} from '@opentunnel/client'

let root = ''
vi.mock('../../config-dir', () => ({
  configDir: (...sub: string[]) => {
    const dir = join(root, ...sub)
    mkdirSync(dir, { recursive: true })
    return dir
  },
}))

import {
  PROFILE,
  getOpenTunnelStatus,
  openTunnel,
  openTunnelIdle,
  resetOpenTunnelForTests,
  RELAY_API,
  type OpenTunnelSdk,
  type TunnelClient,
  type TunnelConnection,
} from '../opentunnel'
import type { TunnelStatus } from '../../../shared/ipc-types'

const TOKEN = '9f3c0a7e5b1d4826aa11cc22dd33ee44ff5566778899aabbccddeeff00112233'
const OTHER_TOKEN = 'a'.repeat(64)
const HOSTNAME = 'shmeg77if6cw.opentunnel.xyz'

function identity(id = 'shmeg77if6cw'): OpenTunnelIdentity {
  return {
    id,
    hostname: HOSTNAME,
    token: 'relay-token',
    privateKey: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
    certificate: 'cert',
    chain: 'chain',
    certificateExpiry: new Date(Date.now() + 86_400_000),
  }
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

function deferred(): Deferred {
  let resolve: () => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  // Rejected before the fake reaches its `await`, which is not a bug here.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** A connection whose events the test pushes. */
class FakeConnection implements TunnelConnection {
  readonly tunnel: OpenTunnelIdentity
  routes: OpenTunnelRoutes
  closeCalls = 0
  readonly setRoutes = vi.fn(async (routes: OpenTunnelRoutes) => { this.routes = routes })
  readonly closed: Promise<void>
  private ended = false
  private queue: OpenTunnelClientEvent[] = []
  private wake: (() => void) | null = null
  private end: () => void = () => {}

  constructor(tunnel: OpenTunnelIdentity, routes: OpenTunnelRoutes) {
    this.tunnel = tunnel
    this.routes = routes
    this.closed = new Promise((resolve) => { this.end = resolve })
  }

  readonly events: AsyncIterable<OpenTunnelClientEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<OpenTunnelClientEvent>> => {
        while (this.queue.length === 0 && !this.ended) {
          await new Promise<void>((resolve) => { this.wake = resolve })
        }
        const value = this.queue.shift()
        return value ? { value, done: false } : { value: undefined, done: true }
      },
    }),
  }

  push(event: OpenTunnelClientEvent): void {
    this.queue.push(event)
    if (event.type === 'stopped') this.ended = true
    this.wake?.()
  }

  /** Holds `close` open until released, as a bridge being torn down is. */
  closeGate: Deferred | null = null
  /** Refuse the close with this. */
  closeFailure: Error | null = null

  async close(): Promise<void> {
    this.closeCalls += 1
    await this.closeGate?.promise
    if (this.closeFailure) throw this.closeFailure
    this.push({ type: 'stopped' })
    this.end()
  }
}

/** Rejects as soon as `signal` aborts, as an interrupted SDK call does. */
function abortable(gate: Deferred | null, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    if (gate) gate.promise.then(resolve, reject)
    else resolve()
  })
}

/**
 * A relay in memory, behind the REAL XDG store on a temp dir: what is on disk
 * is what the provider decides by, so it has to be the real thing. Deletion
 * is not faked at the SDK level at all: the provider sends it with `fetch`,
 * which is stubbed here to answer as the hosted API does.
 */
class FakeRelay {
  /** Tunnel id → its relay token. */
  tunnels = new Map<string, string>()
  connections: FakeConnection[] = []
  creates = 0
  /** Holds `create` open until released, as certificate issuance does for a minute. */
  createGate: Deferred | null = null
  /**
   * Holds `create` between the relay creating the tunnel and its id and token
   * reaching disk, the span the real SDK spends generating a key and a CSR.
   */
  preSaveGate: Deferred | null = null
  /** Holds `connect` open until released. */
  connectGate: Deferred | null = null
  /** Answer every delete with this status instead. */
  deleteStatus: number | null = null
  deletes: string[] = []
  nextId = 'shmeg77if6cw'

  sdk(): OpenTunnelSdk {
    return {
      store: (dataDir) => OpenTunnelStorage.xdg({ env: { XDG_DATA_HOME: dataDir } }),
      client: (store) => this.client(store),
    }
  }

  /** `DELETE /api/tunnel/:id`, as the probe of the hosted API answered it: 204, then 404. */
  readonly fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const id = url.slice(`${RELAY_API}/api/tunnel/`.length)
    if (init?.method !== 'DELETE' || !url.startsWith(`${RELAY_API}/api/tunnel/`)) return new Response(null, { status: 400 })
    this.deletes.push(id)
    if (this.deleteStatus !== null) return new Response(null, { status: this.deleteStatus })
    const relayToken = this.tunnels.get(id)
    if (relayToken === undefined) return new Response(null, { status: 404 })
    if (new Headers(init.headers).get('authorization') !== `Bearer ${relayToken}`) return new Response(null, { status: 401 })
    this.tunnels.delete(id)
    return new Response(null, { status: 204 })
  })

  private client(store: OpenTunnelStorage): TunnelClient {
    return {
      hasIdentity: async () => (await store.load(PROFILE)) !== undefined,
      create: async ({ onProgress, signal }) => {
        // As the SDK does: finish a half-provisioned tunnel, and refuse one
        // whose files it cannot read.
        const half = await store.loadPending(PROFILE)
        if (half) {
          onProgress('resuming-certificate')
          await abortable(this.createGate, signal)
          await store.save(PROFILE, identity(half.id))
          onProgress('ready')
          return
        }
        this.creates += 1
        const made = identity(this.nextId)
        this.tunnels.set(made.id, made.token)
        onProgress('creating-tunnel')
        // Interruptible, as the real SDK is: an abort here strands the tunnel.
        await abortable(this.preSaveGate, signal)
        await store.savePending(PROFILE, { ...made, csr: 'csr' })
        onProgress('requesting-certificate')
        onProgress('waiting-certificate')
        await abortable(this.createGate, signal)
        await store.save(PROFILE, made)
        onProgress('ready')
      },
      connect: async ({ routes, signal }) => {
        await abortable(this.connectGate, signal)
        const stored = await store.load(PROFILE)
        if (!stored) throw new Error('connect without an identity')
        const connection = new FakeConnection(stored, routes)
        this.connections.push(connection)
        return connection
      },
    }
  }
}

let relay: FakeRelay
let seen: TunnelStatus[]
let unsubscribe: () => void

const identityDir = (): string => join(root, 'opentunnel', 'opentunnel', PROFILE)
const routeFile = (): string => join(root, 'opentunnel', 'route')
const last = (): TunnelStatus => getOpenTunnelStatus()

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function publish(port = 52123, token = TOKEN): Promise<void> {
  openTunnel.apply({ port, token })
  await openTunnelIdle()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'se-opentunnel-'))
  relay = new FakeRelay()
  vi.stubGlobal('fetch', relay.fetch)
  resetOpenTunnelForTests(async () => relay.sdk())
  seen = []
  unsubscribe = openTunnel.onChange((status) => seen.push(status))
})

afterEach(() => {
  vi.restoreAllMocks()
  unsubscribe()
  openTunnel.stopSync()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

describe('provisioning', () => {
  it('returns busy at once and reports progress while the certificate is issued', async () => {
    relay.createGate = deferred()
    const accepted = openTunnel.apply({ port: 52123, token: TOKEN })
    expect(accepted.busy).toBe(true)

    await waitFor(() => last().progress?.includes('can take a minute') === true)
    expect(last()).toMatchObject({ busy: true, active: false, url: null })

    relay.createGate.resolve()
    await openTunnelIdle()
    expect(seen.some((status) => status.progress === 'Creating the tunnel…')).toBe(true)
    expect(last()).toMatchObject({ busy: false, active: true, progress: null, connection: 'connected', error: null })
  })

  it('publishes https://<route>.<hostname> with the key, and tunnels to the loopback port', async () => {
    await publish()
    const route = readFileSync(routeFile(), 'utf8')
    expect(route).toMatch(/^[0-9a-f]{16}$/)
    expect(last().url).toBe(`https://${route}.${HOSTNAME}/app/?k=${TOKEN}`)
    expect(relay.connections[0].routes).toEqual({ [route]: '127.0.0.1:52123' })
    // The access key is ours: the relay is handed a port, never the key.
    expect(JSON.stringify(relay.connections[0].routes)).not.toContain(TOKEN)
  })

  it('reports a failed provisioning and stops being busy', async () => {
    relay.createGate = deferred()
    openTunnel.apply({ port: 52123, token: TOKEN })
    relay.createGate.reject(new Error('Failed to create tunnel: rate limited'))
    await openTunnelIdle()
    expect(last()).toMatchObject({ busy: false, active: false, connection: 'reconnecting' })
    expect(last().error).toBe('Failed to create tunnel: rate limited Retrying in 5 s.')
  })
})

describe('what a switch away would lose', () => {
  it('is nothing during a first provisioning, then the published tunnel until it is deleted', async () => {
    expect(last().kept).toBe(false)
    relay.createGate = deferred()
    openTunnel.apply({ port: 52123, token: TOKEN })
    await waitFor(() => existsSync(join(identityDir(), 'pending.json')))
    expect(last().kept).toBe(false)

    relay.createGate.resolve()
    await openTunnelIdle()
    expect(last().kept).toBe(true)
    openTunnel.apply(null)
    await openTunnelIdle()
    expect(last().kept).toBe(true)

    openTunnel.withdraw()
    await openTunnelIdle()
    expect(last().kept).toBe(false)
  })
})

describe('aborting a provisioning', () => {
  // The relay has the tunnel before its id and token are on disk. An abort in
  // that span would leave a tunnel nothing could ever delete.
  it('holds a withdrawal until the new tunnel is on disk, then deletes it', async () => {
    relay.preSaveGate = deferred()
    openTunnel.apply({ port: 52123, token: TOKEN })
    await waitFor(() => relay.creates === 1)
    openTunnel.withdraw()
    relay.preSaveGate.resolve()
    await openTunnelIdle()

    expect(relay.deletes).toEqual(['shmeg77if6cw'])
    expect(relay.tunnels.size).toBe(0)
    expect(existsSync(identityDir())).toBe(false)
  })

  it('times out a stuck certificate, keeps the tunnel on record, and retries it', async () => {
    resetOpenTunnelForTests(async () => relay.sdk(), 50)
    relay.createGate = deferred()
    openTunnel.apply({ port: 52123, token: TOKEN })
    await waitFor(() => last().error !== null)
    expect(last().error).toMatch(/took longer than 0 minutes and was stopped\. Retrying in 5 s\./)
    expect(existsSync(join(identityDir(), 'pending.json'))).toBe(true)
    expect(relay.tunnels.size).toBe(1)
  })
})

describe('a delete the relay keeps refusing', () => {
  it('runs one delete however often it is withdrawn', async () => {
    await publish()
    relay.deleteStatus = 503
    openTunnel.withdraw()
    openTunnel.withdraw()
    openTunnel.withdraw()
    await openTunnelIdle()
    expect(relay.deletes).toHaveLength(1)
  })

  it('can be forgotten, leaving the tunnel on the relay', async () => {
    await publish()
    relay.deleteStatus = 503
    openTunnel.withdraw()
    await openTunnelIdle()
    expect(last().error).toMatch(/Could not delete/)

    openTunnel.forget?.()
    await openTunnelIdle()
    expect(existsSync(identityDir())).toBe(false)
    expect(existsSync(routeFile())).toBe(false)
    expect(relay.tunnels.size).toBe(1)
    expect(last()).toMatchObject({ error: null, kept: false })
  })

  // Every sync withdraws while another exposure is chosen; one landing behind
  // the user's Forget must not turn it back into a delete.
  it('keeps a forget a forget when a sync withdraws behind it', async () => {
    await publish()
    relay.deleteStatus = 503
    openTunnel.withdraw()
    await openTunnelIdle()

    openTunnel.forget?.()
    openTunnel.withdraw()
    await openTunnelIdle()
    expect(relay.deletes).toHaveLength(1)
    expect(existsSync(identityDir())).toBe(false)
    expect(last().error).toBeNull()
  })

  it('cannot be forgotten while OpenTunnel is chosen', async () => {
    await publish()
    openTunnel.forget?.()
    await openTunnelIdle()
    expect(existsSync(identityDir())).toBe(true)
    expect(last().active).toBe(true)
  })
})

describe('an identity a crash left part-written', () => {
  it('is still deleted, from the raw files', async () => {
    await publish()
    openTunnel.apply(null)
    await openTunnelIdle()
    rmSync(join(identityDir(), 'certificate.pem'))

    openTunnel.withdraw()
    await openTunnelIdle()
    expect(relay.deletes).toEqual(['shmeg77if6cw'])
    expect(existsSync(identityDir())).toBe(false)
    expect(last().error).toBeNull()
  })

  it('is replaced by a fresh tunnel when publishing', async () => {
    await publish()
    openTunnel.apply(null)
    await openTunnelIdle()
    rmSync(join(identityDir(), 'certificate.pem'))

    relay.nextId = 'freshtunnel01'
    await publish()
    expect(relay.deletes).toEqual(['shmeg77if6cw'])
    expect(relay.creates).toBe(2)
    expect(last()).toMatchObject({ active: true, error: null })
  })
})

describe('following the server', () => {
  it('re-points the live connection when the port changes, without reconnecting', async () => {
    await publish(52123)
    await publish(60001, OTHER_TOKEN)
    expect(relay.connections).toHaveLength(1)
    const route = readFileSync(routeFile(), 'utf8')
    expect(relay.connections[0].setRoutes).toHaveBeenCalledWith({ [route]: '127.0.0.1:60001' })
    expect(last()).toMatchObject({ port: 60001, url: `https://${route}.${HOSTNAME}/app/?k=${OTHER_TOKEN}` })
  })

  it('only closes when the server stops, and comes back under the same URL', async () => {
    await publish()
    const firstUrl = last().url
    openTunnel.apply(null)
    await openTunnelIdle()

    expect(relay.connections[0].closeCalls).toBe(1)
    expect(last()).toMatchObject({ active: false, url: null, port: null })
    expect(existsSync(identityDir())).toBe(true)
    expect(relay.tunnels.size).toBe(1)

    await publish()
    expect(relay.creates).toBe(1)
    expect(last().url).toBe(firstUrl)
  })
})

describe('deselecting', () => {
  it('closes, deletes the tunnel on the relay, and forgets the identity and route', async () => {
    await publish()
    openTunnel.withdraw()
    await openTunnelIdle()

    expect(relay.connections[0].closeCalls).toBe(1)
    expect(relay.tunnels.size).toBe(0)
    expect(existsSync(identityDir())).toBe(false)
    expect(existsSync(routeFile())).toBe(false)
    expect(last()).toMatchObject({ busy: false, active: false, error: null })
  })

  it('is a no-op, never busy, when nothing is held', () => {
    expect(openTunnel.withdraw().busy).toBe(false)
  })

  it('keeps the identity and says so when the relay refuses the delete', async () => {
    await publish()
    relay.deleteStatus = 503
    openTunnel.withdraw()
    await openTunnelIdle()

    expect(existsSync(join(identityDir(), 'token'))).toBe(true)
    expect(last().error).toMatch(/Could not delete the tunnel on the relay, so it stays on record to try again: the relay answered HTTP 503/)

    relay.deleteStatus = null
    openTunnel.withdraw()
    await openTunnelIdle()
    expect(relay.tunnels.size).toBe(0)
    expect(last().error).toBeNull()
  })

  // The SDK polls for the certificate without end; a withdrawal must not wait
  // behind it, and must delete what the half-done provisioning created.
  it('aborts a provisioning still in flight and deletes the half-made tunnel', async () => {
    relay.createGate = deferred()
    openTunnel.apply({ port: 52123, token: TOKEN })
    await waitFor(() => existsSync(join(identityDir(), 'pending.json')))

    openTunnel.withdraw()
    await openTunnelIdle()
    expect(relay.deletes).toEqual(['shmeg77if6cw'])
    expect(relay.tunnels.size).toBe(0)
    expect(existsSync(identityDir())).toBe(false)
    expect(last()).toMatchObject({ busy: false, error: null, connection: null })
  })

  it('lets a later publish win over a withdrawal still waiting to run', async () => {
    relay.createGate = deferred()
    openTunnel.apply({ port: 52123, token: TOKEN })
    openTunnel.withdraw()
    openTunnel.apply({ port: 52123, token: TOKEN })
    relay.createGate.resolve()
    await openTunnelIdle()
    expect(relay.tunnels.size).toBe(1)
    expect(last().active).toBe(true)
  })
})

describe('startup reclaim', () => {
  it('deletes a stored tunnel when another exposure is chosen', async () => {
    await publish()
    openTunnel.stopSync()
    resetOpenTunnelForTests(async () => relay.sdk())

    await openTunnel.reclaimAbandoned('tailscale-serve')
    await openTunnelIdle()
    expect(relay.tunnels.size).toBe(0)
    expect(existsSync(identityDir())).toBe(false)
  })

  it('keeps it while OpenTunnel is still chosen', async () => {
    await publish()
    openTunnel.stopSync()
    resetOpenTunnelForTests(async () => relay.sdk())

    await openTunnel.reclaimAbandoned('opentunnel')
    await openTunnelIdle()
    expect(relay.tunnels.size).toBe(1)
    expect(existsSync(identityDir())).toBe(true)
  })

  // A quit during the minute of certificate issuance leaves only a pending
  // identity, which the SDK's own `remove` would skip, stranding the tunnel.
  // This goes through the real XDG store and the real delete request.
  it('deletes a half-provisioned tunnel too', async () => {
    relay.createGate = deferred()
    openTunnel.apply({ port: 52123, token: TOKEN })
    await waitFor(() => existsSync(join(identityDir(), 'pending.json')))
    openTunnel.stopSync()
    resetOpenTunnelForTests(async () => relay.sdk())
    expect(relay.tunnels.size).toBe(1)

    await openTunnel.reclaimAbandoned('off')
    await openTunnelIdle()
    expect(relay.deletes).toEqual(['shmeg77if6cw'])
    expect(relay.tunnels.size).toBe(0)
    expect(existsSync(identityDir())).toBe(false)
  })
})

describe('a bridge still closing', () => {
  // Until the close settles the relay can still hand us visitors, so it must
  // count as engaged, or proxy trust reopens for that span.
  it('announces closing, and holds it until the close settles', async () => {
    await publish()
    const connection = relay.connections[0]
    connection.closeGate = deferred()
    seen = []
    openTunnel.withdraw()
    await waitFor(() => connection.closeCalls === 1)
    // Through `onChange`, which is what reaches the pane.
    expect(seen.some((status) => status.connection === 'closing' && !status.active)).toBe(true)
    expect(last()).toMatchObject({ active: false, connection: 'closing' })

    connection.closeGate.resolve()
    await openTunnelIdle()
    expect(last().connection).toBeNull()
  })

  it('reports closing for a bridge that attached after the server stopped', async () => {
    await publish()
    openTunnel.apply(null)
    await openTunnelIdle()

    relay.connectGate = deferred()
    openTunnel.apply({ port: 52123, token: TOKEN })
    await waitFor(() => last().connection === 'connecting')
    openTunnel.apply(null)
    const closeGate = deferred()
    const original = FakeConnection.prototype.close
    vi.spyOn(FakeConnection.prototype, 'close').mockImplementation(async function (this: FakeConnection) {
      this.closeGate = closeGate
      return original.call(this)
    })
    relay.connectGate.resolve()
    await waitFor(() => relay.connections[1]?.closeCalls === 1)
    expect(last()).toMatchObject({ active: false, connection: 'closing' })

    closeGate.resolve()
    await openTunnelIdle()
    await waitFor(() => last().connection === null)
  })
})

describe('a bridge whose close is refused', () => {
  it('stays counted as closing, says so, and is closed by the next step', async () => {
    await publish()
    const connection = relay.connections[0]
    connection.closeFailure = new Error('socket busy')
    openTunnel.apply(null)
    await openTunnelIdle()
    expect(last()).toMatchObject({ connection: 'closing' })
    expect(last().error).toMatch(/Could not close the relay bridge, so forwarded headers stay distrusted until it closes: socket busy/)

    connection.closeFailure = null
    openTunnel.withdraw()
    await openTunnelIdle()
    await waitFor(() => last().connection === null)
    expect(last().error).toBeNull()
  })
})

describe('quit while a bridge is up', () => {
  it('announces closing', async () => {
    await publish()
    relay.connections[0].closeGate = deferred()
    seen = []
    openTunnel.stopSync()
    expect(seen.at(-1)).toMatchObject({ active: false, connection: 'closing' })
    relay.connections[0].closeGate?.resolve()
  })
})

describe('a half-provisioned tunnel on disk at publish', () => {
  async function storePending(id: string): Promise<void> {
    const store = OpenTunnelStorage.xdg({ env: { XDG_DATA_HOME: join(root, 'opentunnel') } })
    const half = identity(id)
    relay.tunnels.set(half.id, half.token)
    await store.savePending(PROFILE, { ...half, csr: 'csr' })
  }

  it('is resumed when it is complete, not deleted', async () => {
    await storePending('halfdoneone1')
    await publish()
    expect(relay.deletes).toEqual([])
    expect(relay.creates).toBe(0)
    expect(last()).toMatchObject({ active: true, error: null })
  })

  // A permissions or I/O failure says nothing about the tunnel, and must not
  // get a healthy one deleted.
  it('is left alone, with an error, when it cannot be read', async () => {
    await storePending('halfdoneone1')
    const pendingFile = join(identityDir(), 'pending.json')
    chmodSync(pendingFile, 0o000)
    try {
      openTunnel.apply({ port: 52123, token: TOKEN })
      await openTunnelIdle()
      expect(relay.deletes).toEqual([])
      expect(relay.tunnels.has('halfdoneone1')).toBe(true)
      expect(last().error).toMatch(/EACCES/)
    } finally {
      chmodSync(pendingFile, 0o600)
    }
  })
})

describe('a half-provisioned tunnel a crash left unreadable', () => {
  it('is deleted from the raw files and replaced when publishing', async () => {
    const store = OpenTunnelStorage.xdg({ env: { XDG_DATA_HOME: join(root, 'opentunnel') } })
    const stranded = identity('strandedone1')
    relay.tunnels.set(stranded.id, stranded.token)
    await store.savePending(PROFILE, { ...stranded, csr: 'csr' })
    rmSync(join(identityDir(), 'private-key.pem'))

    relay.nextId = 'freshtunnel01'
    await publish()
    expect(relay.deletes).toEqual(['strandedone1'])
    expect([...relay.tunnels.keys()]).toEqual(['freshtunnel01'])
    expect(last()).toMatchObject({ active: true, error: null })
  })
})

describe('a connect that lands after the server stopped', () => {
  it('reports the bridge as attaching, then closes it instead of publishing', async () => {
    await publish()
    openTunnel.apply(null)
    await openTunnelIdle()

    relay.connectGate = deferred()
    openTunnel.apply({ port: 52123, token: TOKEN })
    await waitFor(() => last().connection === 'connecting')
    openTunnel.apply(null)
    relay.connectGate.resolve()
    await openTunnelIdle()

    expect(relay.connections[1].closeCalls).toBe(1)
    expect(last()).toMatchObject({ active: false, port: null, connection: null })
  })
})

describe('quit', () => {
  it('closes without waiting and keeps the tunnel for the next start', async () => {
    await publish()
    openTunnel.stopSync()
    expect(relay.connections[0].closeCalls).toBe(1)
    expect(last()).toMatchObject({ active: false, busy: false, url: null })
    expect(existsSync(identityDir())).toBe(true)
  })

  it('aborts a connect still in flight instead of publishing after quit', async () => {
    await publish()
    openTunnel.apply(null)
    await openTunnelIdle()

    relay.connectGate = deferred()
    openTunnel.apply({ port: 52123, token: TOKEN })
    await waitFor(() => last().progress === 'Connecting to the relay…')
    openTunnel.stopSync()
    relay.connectGate.resolve()
    await openTunnelIdle()

    expect(relay.connections).toHaveLength(1)
    expect(last()).toMatchObject({ active: false, error: null })
  })
})

describe('connection state', () => {
  it('follows the relay through a reconnect', async () => {
    await publish()
    const connection = relay.connections[0]
    connection.push({ type: 'disconnected', reason: 'socket hang up' })
    connection.push({ type: 'reconnecting', attempt: 1, delayMs: 500 })
    await waitFor(() => last().connection === 'reconnecting')
    expect(last().error).toBe('Lost the connection to the relay: socket hang up')
    // The URL does not change while the bridge is down.
    expect(last().active).toBe(true)

    connection.push({ type: 'connected', session: 's', routes: [] })
    await waitFor(() => last().connection === 'connected')
    expect(last().error).toBeNull()
  })

  it('drops the URL when the tunnel stops on its own, then reconnects with backoff', async () => {
    await publish()
    vi.useFakeTimers()
    try {
      relay.connections[0].push({ type: 'stopped', error: 'bridge closed' })
      await vi.advanceTimersByTimeAsync(0)
      expect(last()).toMatchObject({
        url: null,
        connection: 'reconnecting',
        error: 'The tunnel stopped: bridge closed Retrying in 5 s.',
      })
      await vi.advanceTimersByTimeAsync(5_000)
    } finally {
      vi.useRealTimers()
    }
    await openTunnelIdle()
    expect(relay.connections).toHaveLength(2)
    expect(last()).toMatchObject({ active: true, connection: 'connected', error: null })
  })

  it('does not retry once OpenTunnel is no longer wanted', async () => {
    await publish()
    vi.useFakeTimers()
    try {
      relay.connections[0].push({ type: 'stopped', error: 'bridge closed' })
      await vi.advanceTimersByTimeAsync(0)
      openTunnel.apply(null)
      await vi.advanceTimersByTimeAsync(60_000)
    } finally {
      vi.useRealTimers()
    }
    await openTunnelIdle()
    expect(relay.connections).toHaveLength(1)
    expect(last().connection).toBeNull()
  })
})

describe('what is written to disk', () => {
  const mode = (path: string): number => statSync(path).mode & 0o777

  // The relay token deletes the tunnel and the key serves its certificate.
  // The SDK's store sets these modes itself; this pins that against an upgrade.
  it('keeps the token and private key owner-only', async () => {
    await publish()
    for (const file of ['token', 'private-key.pem', 'tunnel.json', 'certificate.pem', 'chain.pem']) {
      expect(mode(join(identityDir(), file)), file).toBe(0o600)
    }
    expect(mode(identityDir())).toBe(0o700)
    expect(mode(join(root, 'opentunnel', 'opentunnel'))).toBe(0o700)
    expect(mode(join(root, 'opentunnel'))).toBe(0o700)
    expect(mode(routeFile())).toBe(0o600)
  })
})
