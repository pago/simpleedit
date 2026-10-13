/**
 * OpenTunnel: a public HTTPS address for the phone, through a third-party relay.
 *
 * The SDK runs in this process. It holds a WebSocket bridge to the relay, the
 * relay routes visitors to it by SNI, and TLS ends HERE with a certificate the
 * SDK requested for the tunnel's own hostname. Requests then reach the remote
 * server over loopback as plain HTTP.
 *
 * ── Trust ─────────────────────────────────────────────────────────────────
 * Unlike Tailscale Serve there is no access control in front of us: anyone
 * with the URL reaches the sign-in page, and the access key is the only
 * boundary. Every visitor arrives from 127.0.0.1 with its own headers intact,
 * so this provider declares its proxy untrusted and the server ignores
 * `x-forwarded-*` while it is chosen or still engaged — a bridge live or being
 * attached, or a port held (`proxyTrust` in `reachability.ts`).
 *
 * The URL is `https://<route>.<tunnel hostname>`. The certificate covers the
 * hostname and its wildcard, so the hostname is in Certificate Transparency
 * logs but the route never is. The route is 64 random bits, so the URL cannot
 * be found by scanning those logs.
 *
 * ── Lifetime ──────────────────────────────────────────────────────────────
 * Two things, with two lifetimes:
 *
 *  - The CONNECTION follows the server: made when it starts, closed when it
 *    stops (a restart closes it before the new server listens, so the relay
 *    never routes to a port that is free for the taking) and at quit. If the
 *    relay ends it while it is still wanted, it is retried with backoff.
 *  - The TUNNEL (identity, token, certificate, route) outlives all of that, so
 *    the next start comes back under the same URL and an installed phone app
 *    keeps working. It is deleted on the relay only when the exposure moves
 *    away from OpenTunnel, or at launch when one is on disk while another
 *    exposure is chosen. Tunnels never expire on their own, so a deletion that
 *    fails keeps everything on disk and is tried again by the next withdrawal.
 *
 * First provisioning takes 40–60 s while the relay obtains a certificate;
 * reconnecting with a stored identity takes about one. Nothing waits on either:
 * `apply` returns `busy` with a progress line and the outcome arrives through
 * `onChange`. Provisioning is bounded (`PROVISION_TIMEOUT_MS`) and a withdrawal
 * or quit aborts it, because the SDK's certificate poll has no end of its own
 * and would otherwise hold every later request behind it. The abort waits for
 * the identity to be on disk, though (see `UNSAFE_FROM` and `SAFE_AGAIN`), and
 * the relay's create request has no deadline of ours: the SDK gives no way to
 * bound it without risking a tunnel we never learn the token of.
 *
 * ── Storage ───────────────────────────────────────────────────────────────
 * The SDK's XDG store, rooted at `configDir('opentunnel')`. It holds the
 * relay token and the private key, and writes them 0600 in a 0700 directory
 * (`opentunnel.test.ts` checks that against the real store).
 */
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type {
  OpenTunnelClientEvent,
  OpenTunnelProvisionStage,
  OpenTunnelRoutes,
  OpenTunnelStorage,
} from '@opentunnel/client'
import { configDir } from '../config-dir'
import { appLink } from '../../shared/remote-pairing'
import type { RemoteExposure, TunnelConnectionState, TunnelStatus } from '../../shared/ipc-types'
import type { ReachabilityProvider, TunnelTarget } from './reachability'

/** The SDK profile, and so the directory under the store's root. */
export const PROFILE = 'simpleedit'

/** The hosted service. The SDK's own default, restated for the delete we send ourselves. */
export const RELAY_API = 'https://opentunnel.xyz'

/** Certificate issuance takes about a minute; three means something is stuck. */
const PROVISION_TIMEOUT_MS = 3 * 60_000
let provisionTimeoutMs = PROVISION_TIMEOUT_MS
const DELETE_TIMEOUT_MS = 20_000
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

/** A live bridge, as far as this provider uses one. */
export interface TunnelConnection {
  readonly tunnel: { readonly hostname: string }
  readonly events: AsyncIterable<OpenTunnelClientEvent>
  setRoutes(routes: OpenTunnelRoutes): Promise<void>
  close(): Promise<void>
}

/** The SDK operations this provider runs, each abortable where the SDK's promise API is not. */
export interface TunnelClient {
  hasIdentity(): Promise<boolean>
  create(options: { onProgress: (stage: OpenTunnelProvisionStage) => void; signal: AbortSignal }): Promise<void>
  connect(options: { routes: OpenTunnelRoutes; signal: AbortSignal }): Promise<TunnelConnection>
}

export interface OpenTunnelSdk {
  store(dataDir: string): OpenTunnelStorage
  client(store: OpenTunnelStorage): TunnelClient
}

/**
 * Loaded on first use, not at startup: the SDK brings Effect with it, and a
 * user who never picks OpenTunnel should not pay for evaluating it.
 */
async function loadSdk(): Promise<OpenTunnelSdk> {
  return (await import('./opentunnel-sdk')).openTunnelSdk
}

const STAGE_TEXT: Record<OpenTunnelProvisionStage, string> = {
  'creating-tunnel': 'Creating the tunnel…',
  'generating-key': 'Generating a key…',
  'generating-csr': 'Generating a key…',
  'resuming-certificate': 'Resuming the certificate request…',
  'requesting-certificate': 'Requesting a certificate…',
  'waiting-certificate': 'Waiting for the certificate. The first time, this can take a minute…',
  'saving-identity': 'Saving the tunnel…',
  ready: 'Connecting to the relay…',
}

const ROUTE_SHAPE = /^[0-9a-f]{16}$/

/**
 * In SDK 0.5.1, `create` asks the relay for a tunnel at `creating-tunnel` and
 * persists its id and token (`savePending`) only after generating a key and a
 * CSR; `requesting-certificate` is the first stage after that write. An
 * interrupt in between leaves a tunnel on the relay that nothing here can name,
 * let alone delete. So from the first stage to the next one past the write, an
 * abort is held and delivered on arrival there. (`resuming-certificate` starts
 * from an identity already on disk.)
 */
const UNSAFE_FROM: OpenTunnelProvisionStage = 'creating-tunnel'
const SAFE_AGAIN: ReadonlySet<OpenTunnelProvisionStage> = new Set([
  'resuming-certificate',
  'requesting-certificate',
  'waiting-certificate',
  'saving-identity',
  'ready',
])

type Intent =
  | { kind: 'publish'; target: TunnelTarget }
  /** The server is down, but OpenTunnel is still chosen: keep the tunnel. */
  | { kind: 'close' }
  /** OpenTunnel is no longer chosen: delete the tunnel on the relay. */
  | { kind: 'remove' }
  /** The user gave up on deleting it: drop it here, leaving the relay as it is. */
  | { kind: 'forget' }

interface Live {
  connection: TunnelConnection
  port: number
  route: string
  hostname: string
  state: Exclude<TunnelConnectionState, 'closing'>
}

let intent: Intent = { kind: 'close' }
let live: Live | null = null
/** The running server's access key. Only ever put into the URL we show, never handed to the SDK. */
let token: string | null = null
let progress: string | null = null
let lastError: string | null = null
/** Requests made and not yet run. `busy` is simply "any left". */
let pending = 0
let busy = false
let chain: Promise<void> = Promise.resolve()
/**
 * Bumped by `stopSync`. A connect still in flight when it ran comes back to a
 * different epoch and closes what it got, instead of publishing after quit.
 */
let epoch = 0
/** The provisioning in flight, so a withdrawal or quit can abort it. */
let provisioning: { abort(): void } | null = null
/** A connect is in flight: a bridge may already be attached, so visitors may arrive. */
let attaching = false
/**
 * Bridges whose close has not settled. Until it has, the relay can still hand
 * us visitors, so they count as engaged for proxy trust like a live one.
 */
const closingBridges = new Set<TunnelConnection>()
/**
 * Bridges whose close was refused. They stay in `closingBridges`, so proxy
 * trust stays closed, and the next step or quit tries again.
 */
const stuckBridges = new Set<TunnelConnection>()
let closeError: string | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
/** Whether a fully provisioned identity is on disk; cached because status is read per request. */
let keptCache: boolean | null = null
let retryAttempt = 0

let sdkLoader: () => Promise<OpenTunnelSdk> = loadSdk
let sdk: Promise<OpenTunnelSdk> | null = null
let client: TunnelClient | null = null
let dataDirReady = false

function dataDir(): string {
  const dir = configDir('opentunnel')
  if (!dataDirReady) {
    // `configDir` creates with the default mode, and this one holds a token
    // and a private key.
    try { chmodSync(dir, 0o700) } catch { /* best effort; the SDK's own dir below is 0700 */ }
    dataDirReady = true
  }
  return dir
}

function identityDir(): string {
  return join(dataDir(), 'opentunnel', PROFILE)
}

function kept(): boolean {
  keptCache ??= existsSync(join(identityDir(), 'tunnel.json'))
  return keptCache
}

function routeFile(): string {
  return join(dataDir(), 'route')
}

/** The route label, minted once per tunnel so the URL survives restarts. */
function routeName(): string {
  try {
    const stored = readFileSync(routeFile(), 'utf8').trim()
    if (ROUTE_SHAPE.test(stored)) return stored
  } catch {
    /* none yet */
  }
  const fresh = randomBytes(8).toString('hex')
  writeFileSync(routeFile(), fresh, { mode: 0o600 })
  return fresh
}

function routesFor(route: string, port: number): OpenTunnelRoutes {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Refusing to tunnel port ${port}`)
  return { [route]: `127.0.0.1:${port}` }
}

function getSdk(): Promise<OpenTunnelSdk> {
  sdk ??= sdkLoader()
  return sdk
}

async function getClient(): Promise<TunnelClient> {
  if (client) return client
  const loaded = await getSdk()
  client ??= loaded.client(loaded.store(dataDir()))
  return client
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function getOpenTunnelStatus(): TunnelStatus {
  const url = live && token ? appLink(`https://${live.route}.${live.hostname}`, token) : null
  return {
    active: url !== null,
    port: live?.port ?? null,
    url,
    busy,
    enableUrl: null,
    error: lastError ?? closeError,
    progress: busy ? progress : null,
    connection:
      live?.state ??
      (attaching ? 'connecting' : closingBridges.size > 0 ? 'closing' : retryTimer ? 'reconnecting' : null),
    kept: kept(),
  }
}

const listeners = new Set<(status: TunnelStatus) => void>()

function emit(): TunnelStatus {
  const status = getOpenTunnelStatus()
  for (const listener of listeners) listener(status)
  return status
}

function setProgress(text: string): void {
  progress = text
  emit()
}

function enqueue(): Promise<void> {
  pending += 1
  busy = true
  // Counted against the epoch it was queued in: `stopSync` zeroes the count,
  // and a step queued before that must not then take one off a later request.
  const queuedIn = epoch
  const run = (): Promise<void> => step(queuedIn)
  chain = chain.then(run, run)
  return chain
}

function abortProvisioning(): void {
  provisioning?.abort()
  provisioning = null
}

function cancelRetry(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
}

/** Publishing is still wanted and failed, or the relay ended it: try again, later each time. */
function scheduleRetry(): void {
  if (intent.kind !== 'publish' || retryTimer) return
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retryAttempt)
  retryAttempt += 1
  lastError = `${lastError ?? 'The tunnel is down.'} Retrying in ${Math.round(delay / 1000)} s.`
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (intent.kind === 'publish' && !live) void enqueue()
  }, delay)
  retryTimer.unref?.()
}

async function step(queuedIn: number): Promise<void> {
  retryStuckBridges()
  // Read here, not at call time: whatever the latest intent is, that is the
  // one this step implements. Superseded requests collapse into a no-op.
  const want = intent
  try {
    if (want.kind === 'publish') {
      await publish(want)
    } else {
      await closeLive()
      if (want.kind === 'remove') await removeTunnel()
      else if (want.kind === 'forget') forgetTunnel()
      else lastError = null
    }
  } catch (error: unknown) {
    // An abort we asked for is not a failure; whatever replaced the intent is
    // queued behind this step.
    if (intent === want) {
      lastError = describe(error)
      console.error('[OpenTunnel]', lastError)
      if (want.kind === 'publish') scheduleRetry()
    }
  } finally {
    if (queuedIn === epoch) pending = Math.max(0, pending - 1)
    busy = pending > 0
    if (!busy) progress = null
    emit()
  }
}

async function publish(want: Extract<Intent, { kind: 'publish' }>): Promise<void> {
  const { port } = want.target
  if (live) {
    if (live.port !== port) {
      setProgress('Pointing the tunnel at the new port…')
      // Changing only a target applies without re-attaching the bridge.
      await live.connection.setRoutes(routesFor(live.route, port))
      live.port = port
    }
    token = want.target.token
    return
  }

  const started = epoch
  const sdkAbort = new AbortController()
  let interruptible = true
  let abortHeld = false
  let timedOut = false
  let cancelled = false
  const requestAbort = (): void => {
    abortHeld = true
    if (interruptible) sdkAbort.abort()
  }
  const handle = { abort: () => { cancelled = true; requestAbort() } }
  provisioning = handle
  const timeout = setTimeout(() => { timedOut = true; requestAbort() }, provisionTimeoutMs)
  timeout.unref?.()
  const onProgress = (stage: OpenTunnelProvisionStage): void => {
    if (stage === UNSAFE_FROM) interruptible = false
    else if (SAFE_AGAIN.has(stage)) {
      interruptible = true
      if (abortHeld) sdkAbort.abort()
    }
    setProgress(STAGE_TEXT[stage])
  }
  try {
    const tunnels = await getClient()
    if (!(await hasUsableIdentity(tunnels))) {
      await dropUnreadablePending()
      setProgress(STAGE_TEXT['creating-tunnel'])
      // `create` also finishes a provisioning an earlier run left half done.
      try {
        await tunnels.create({ onProgress, signal: sdkAbort.signal })
      } finally {
        keptCache = null
      }
      if (intent !== want || abortHeld) return
    }
    setProgress(STAGE_TEXT.ready)
    const route = routeName()
    attaching = true
    emit()
    let connection: TunnelConnection
    try {
      connection = await tunnels.connect({ routes: routesFor(route, port), signal: sdkAbort.signal })
    } finally {
      attaching = false
    }
    // Quit, a withdrawal, or the server stopping while this attached: none of
    // them wants a bridge to a port that may already be someone else's.
    if (epoch !== started || abortHeld || intent.kind !== 'publish') {
      void closeBridge(connection).catch(() => {})
      return
    }
    // Kept even if the intent moved to another port meanwhile: the step queued
    // behind this one re-points it, which is cheaper than reconnecting.
    live = { connection, port, route, hostname: connection.tunnel.hostname, state: 'connected' }
    token = want.target.token
    lastError = null
    retryAttempt = 0
    watch(connection)
  } catch (error: unknown) {
    if (timedOut && !cancelled) {
      throw new Error(`Setting up the tunnel took longer than ${Math.round(provisionTimeoutMs / 60_000)} minutes and was stopped.`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    if (provisioning === handle) provisioning = null
  }
}

/**
 * Is the identity described by `meta` part-written? True only for what a
 * crash during a save leaves: a file missing, or metadata that is not JSON.
 * Any other failure to read (EACCES, EMFILE, EIO) is thrown, because it says
 * nothing about the tunnel and must never get it deleted.
 */
function isPartIdentity(meta: string, files: readonly string[]): boolean {
  const dir = identityDir()
  for (const file of [meta, ...files]) {
    try {
      statSync(join(dir, file))
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true
      throw error
    }
  }
  const raw = readFileSync(join(dir, meta), 'utf8')
  try {
    JSON.parse(raw)
    return false
  } catch {
    return true
  }
}

/**
 * `savePending` writes its files in parallel, so a crash can leave a pending
 * identity the SDK cannot read, and its `create` then refuses for good. Delete
 * that tunnel on the relay from the raw files and start over. A complete one
 * is left for `create` to resume.
 */
async function dropUnreadablePending(): Promise<void> {
  if (!existsSync(join(identityDir(), 'pending.json'))) return
  if (!isPartIdentity('pending.json', ['token', 'private-key.pem'])) return
  console.error('[OpenTunnel] Half-provisioned tunnel was only partly saved; replacing it')
  await removeTunnel()
}

/**
 * The SDK refuses both to connect and to create while a stored identity is
 * unreadable (a crash part-way through saving one). Delete it, on the relay
 * too, and start over: a new address beats one that can never be used again.
 */
async function hasUsableIdentity(tunnels: TunnelClient): Promise<boolean> {
  try {
    return await tunnels.hasIdentity()
  } catch (error: unknown) {
    if (!isPartIdentity('tunnel.json', ['token', 'private-key.pem', 'certificate.pem', 'chain.pem'])) throw error
    console.error('[OpenTunnel] Stored tunnel was only partly saved; replacing it:', describe(error))
    await removeTunnel()
    return false
  }
}

function watch(connection: TunnelConnection): void {
  void (async () => {
    for await (const event of connection.events) onEvent(connection, event)
  })().catch((error: unknown) => {
    if (live?.connection !== connection) return
    lastError = describe(error)
    emit()
  })
}

function onEvent(connection: TunnelConnection, event: OpenTunnelClientEvent): void {
  // Our own close also ends in `stopped`; by then `live` has moved on.
  if (live?.connection !== connection) return
  switch (event.type) {
    case 'connecting':
      live.state = 'connecting'
      break
    case 'connected':
      live.state = 'connected'
      lastError = null
      break
    case 'disconnected':
      live.state = 'reconnecting'
      lastError = `Lost the connection to the relay: ${event.reason}`
      break
    case 'reconnecting':
      live.state = 'reconnecting'
      break
    case 'stopped':
      live = null
      token = null
      lastError = event.error ? `The tunnel stopped: ${event.error}` : 'The tunnel stopped.'
      console.error('[OpenTunnel]', lastError)
      scheduleRetry()
      break
    case 'certificate-renewed':
      console.log(`[OpenTunnel] Certificate renewed, valid until ${event.expiry}`)
      return
    default:
      return
  }
  emit()
}

/** A refused close is tracked by `closeBridge`; what follows must still run. */
async function closeLive(): Promise<void> {
  const current = live
  live = null
  token = null
  if (!current) return
  await closeBridge(current.connection).catch(() => {})
}

/**
 * Close a bridge, counting it as engaged until the close has succeeded. A
 * refused close keeps it counted (fail closed) and is reported.
 */
function closeBridge(connection: TunnelConnection): Promise<void> {
  closingBridges.add(connection)
  stuckBridges.delete(connection)
  emit()
  return connection.close().then(
    () => {
      closingBridges.delete(connection)
      if (stuckBridges.size === 0) closeError = null
      emit()
    },
    (error: unknown) => {
      stuckBridges.add(connection)
      closeError = `Could not close the relay bridge, so forwarded headers stay distrusted until it closes: ${describe(error)}`
      console.error('[OpenTunnel]', closeError)
      emit()
      throw error
    },
  )
}

function retryStuckBridges(): void {
  for (const connection of [...stuckBridges]) void closeBridge(connection).catch(() => {})
}

/**
 * Delete the tunnel on the relay, then forget it here.
 *
 * Sent ourselves rather than through the SDK's `remove`, which loads only a
 * fully provisioned identity and silently does nothing for one an earlier run
 * left half done. The pending identity has what the delete needs: the id and
 * the token. Nothing local is forgotten until the relay confirms the tunnel is
 * gone, so a failure leaves something to try again with.
 */
async function removeTunnel(): Promise<void> {
  if (!existsSync(identityDir())) {
    forgetRoute()
    lastError = null
    return
  }
  setProgress('Deleting the tunnel…')
  const store = (await getSdk()).store(dataDir())
  const held = await heldCredentials(store)
  if (held) {
    try {
      await deleteOnRelay(held.id, held.token)
    } catch (error: unknown) {
      throw new Error(`Could not delete the tunnel on the relay, so it stays on record to try again: ${describe(error)}`)
    }
  }
  await store.remove(PROFILE)
  keptCache = null
  forgetRoute()
  lastError = null
  console.log('[OpenTunnel] Deleted the tunnel')
}

/**
 * The id and token to delete with: from the full identity, the pending one,
 * or failing both the raw files. The SDK's loaders throw on an identity a
 * crash left part-written, and that must not make it undeletable.
 */
async function heldCredentials(store: OpenTunnelStorage): Promise<{ id: string; token: string } | null> {
  try {
    const full = await store.load(PROFILE)
    if (full) return full
  } catch { /* part-written; try the next source */ }
  try {
    const half = await store.loadPending(PROFILE)
    if (half) return half
  } catch { /* likewise */ }
  let relayToken: string
  try {
    relayToken = readFileSync(join(identityDir(), 'token'), 'utf8').trim()
  } catch {
    return null
  }
  for (const file of ['tunnel.json', 'pending.json']) {
    try {
      const meta: unknown = JSON.parse(readFileSync(join(identityDir(), file), 'utf8'))
      if (typeof meta === 'object' && meta !== null && 'id' in meta && typeof meta.id === 'string' && relayToken) {
        return { id: meta.id, token: relayToken }
      }
    } catch { /* missing or corrupt; try the other */ }
  }
  return null
}

/** Drop the tunnel here without deleting it on the relay, at the user's word. */
function forgetTunnel(): void {
  rmSync(identityDir(), { recursive: true, force: true })
  keptCache = null
  forgetRoute()
  lastError = null
  console.warn('[OpenTunnel] Forgot the tunnel without deleting it on the relay')
}

/** `DELETE /api/tunnel/:id`. A 404 is success: the tunnel is already gone. */
async function deleteOnRelay(id: string, relayToken: string): Promise<void> {
  const response = await fetch(`${RELAY_API}/api/tunnel/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${relayToken}` },
    signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
  })
  if (response.ok || response.status === 404) return
  throw new Error(`the relay answered HTTP ${response.status}`)
}

function forgetRoute(): void {
  rmSync(routeFile(), { force: true })
}

/** Something is held on disk or in memory that a withdrawal would have to remove. */
function holdsAnything(): boolean {
  return pending > 0 || live !== null || existsSync(identityDir())
}

export function applyOpenTunnel(target: TunnelTarget | null): TunnelStatus {
  cancelRetry()
  intent = target ? { kind: 'publish', target } : { kind: 'close' }
  if (target || holdsAnything()) void enqueue()
  else lastError = null
  return emit()
}

export function withdrawOpenTunnel(): TunnelStatus {
  cancelRetry()
  retryAttempt = 0
  abortProvisioning()
  // Every sync withdraws while another exposure is chosen. With a removal
  // already queued, another would only stack a second delete behind it.
  // A forget the user asked for stands: a sync must not turn it back into a
  // delete against the relay that just refused one.
  const queued = (intent.kind === 'remove' || intent.kind === 'forget') && pending > 0
  if (!queued) intent = { kind: 'remove' }
  if (!queued && holdsAnything()) void enqueue()
  else if (!queued) lastError = null
  return emit()
}

/**
 * The user's way out of a delete that keeps failing: forget the tunnel here
 * and leave it on the relay. Only while OpenTunnel is not chosen.
 */
export function forgetOpenTunnel(): TunnelStatus {
  if (intent.kind === 'publish' || intent.kind === 'close') return getOpenTunnelStatus()
  intent = { kind: 'forget' }
  void enqueue()
  return emit()
}

/** Close without waiting, for quit. The tunnel itself stays, so the URL survives. */
export function stopOpenTunnelSync(): void {
  epoch += 1
  cancelRetry()
  abortProvisioning()
  if (intent.kind === 'publish') intent = { kind: 'close' }
  pending = 0
  busy = false
  progress = null
  const current = live
  live = null
  token = null
  if (current) void closeBridge(current.connection).catch(() => {})
  retryStuckBridges()
}

/**
 * Delete a tunnel left on disk while another exposure is chosen.
 *
 * Not awaited, unlike Tailscale's reclaim: nothing here can collide with the
 * server about to start, and a relay that is down must not hold remote access
 * up. The removal is queued, and the sync that follows the server start
 * withdraws again behind it.
 */
export async function reclaimAbandonedOpenTunnel(exposure: RemoteExposure): Promise<void> {
  if (exposure === 'opentunnel') return
  withdrawOpenTunnel()
}

export const openTunnel: ReachabilityProvider = {
  id: 'opentunnel',
  trustsForwardedHeaders: false,
  apply: applyOpenTunnel,
  withdraw: withdrawOpenTunnel,
  status: getOpenTunnelStatus,
  forget: forgetOpenTunnel,
  stopSync: stopOpenTunnelSync,
  reclaimAbandoned: reclaimAbandonedOpenTunnel,
  onChange(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

/** Test seam: stand in for the SDK, and forget everything this module holds. */
export function resetOpenTunnelForTests(
  loader: () => Promise<OpenTunnelSdk> = loadSdk,
  timeoutMs = PROVISION_TIMEOUT_MS,
): void {
  provisionTimeoutMs = timeoutMs
  cancelRetry()
  abortProvisioning()
  sdkLoader = loader
  keptCache = null
  sdk = null
  client = null
  dataDirReady = false
  intent = { kind: 'close' }
  live = null
  token = null
  progress = null
  lastError = null
  pending = 0
  busy = false
  chain = Promise.resolve()
  epoch += 1
  retryAttempt = 0
  attaching = false
  closingBridges.clear()
  stuckBridges.clear()
  closeError = null
}

/** Test seam: settle once every queued request has run. */
export function openTunnelIdle(): Promise<void> {
  return chain
}
