/**
 * Push notifications: one buzz, when a session is genuinely blocked on you.
 *
 * ── The value is in what this does NOT send ───────────────────────────────
 * A notification that might mean something is worse than none. You are on a
 * treadmill; you stop, you take the phone out, and if it was a mis-parsed
 * terminal title you have learnt to ignore the next one — which is the one
 * that mattered. So the trigger is deliberately narrow, and every gate below
 * fails towards silence:
 *
 *  - `precise` only. An inferred status never fires. That leaves out
 *    `initializing` and `exited`, and it leaves out anything guessed from
 *    output we did not ask for.
 *  - `waiting` only, and only as a TRANSITION into it. A session already
 *    blocked does not buzz again because something else changed.
 *  - Debounced per session. An agent that flickers in and out of `waiting`
 *    gets one notification, not six.
 *  - Nothing while the server is down. A tap has to land somewhere alive, and
 *    with remote access off there is no URL to open.
 *
 * ── Four lifetimes ────────────────────────────────────────────────────────
 * The plan's recurring root cause, so stated rather than left implied:
 *
 *  | Thing                | Owned by            | Released when                   |
 *  | -------------------- | ------------------- | ------------------------------- |
 *  | VAPID key pair       | the installation    | never (rotating drops everyone) |
 *  | A subscription       | the DEVICE that made it | its endpoint returns 404/410, or the user forgets devices |
 *  | The per-session gate | the terminal id     | that session reports `exited`   |
 *  | The delivery attempt | the call            | its HTTP response, or a timeout |
 *
 * A subscription is deliberately NOT owned by the server, the window or the
 * socket. The phone that subscribed is a device you still own after a
 * restart, and its subscription outliving every one of those is the entire
 * point: the notification exists precisely for when nothing is connected.
 *
 * ── The secret ────────────────────────────────────────────────────────────
 * The VAPID private key never leaves this module. `push:status` — which IS
 * reachable over the remote socket — returns the public key, because a
 * browser needs it to subscribe, and returns device ROWS rather than
 * endpoints, because an endpoint is a capability to push to that device.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import type { AgentStatusEvent, PushDevice, PushStatus, PushSubscriptionInput } from '../../shared/ipc-types'
import {
  generateVapidKeys,
  isGoneStatus,
  isValidVapidKeys,
  sendPush,
  type PushTransport,
  type VapidKeyPair,
} from './webpush'

/**
 * How long after notifying about a session we stay quiet about it.
 *
 * Long enough that a flapping agent cannot buzz twice, short enough that a
 * second genuine block ten minutes later still reaches you.
 */
const DEBOUNCE_MS = 5 * 60 * 1000

/**
 * A cap on devices, so a token holder cannot grow the file without bound.
 * Nobody carries eight phones; a store that keeps growing is a bug.
 */
const MAX_DEVICES = 8

/** RFC 8292 §2.1 wants a contact. It is not published anywhere a person reads. */
const VAPID_SUBJECT = 'mailto:simpleedit@localhost'

interface StoredSubscription {
  /** Stable, derived from the endpoint — safe to show and to address by. */
  id: string
  endpoint: string
  p256dh: string
  auth: string
  label: string
  createdAt: number
  lastPushAt: number | null
  lastError: string | null
}

interface PushFile {
  vapid: VapidKeyPair
  subscriptions: StoredSubscription[]
}

let cached: PushFile | null = null
let lastError: string | null = null

/** Injectable, so tests never touch the network or the real userData dir. */
interface Deps {
  transport?: PushTransport
  now: () => number
  /** Where a notification tap should land, or null when nothing is reachable. */
  targetUrl: () => string | null
  /** A session's display label, for the notification title. */
  labelFor: (windowId: number, terminalId: string) => string | null
  onStatusChange?: (status: PushStatus) => void
}

let deps: Deps = {
  now: () => Date.now(),
  targetUrl: () => null,
  labelFor: () => null,
}

export function configurePush(next: Partial<Deps>): void {
  deps = { ...deps, ...next }
}

function filePath(): string {
  // Same escape hatch the remote config uses: E2E must never write a real
  // VAPID key or a real subscription into the dev build's userData.
  if (process.env.SIMPLEEDIT_E2E_PUSH_CONFIG) return process.env.SIMPLEEDIT_E2E_PUSH_CONFIG
  const dir = join(app.getPath('userData'), 'config')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'push.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readSubscription(value: unknown): StoredSubscription | null {
  if (!isRecord(value)) return null
  const { id, endpoint, p256dh, auth, label, createdAt, lastPushAt, lastError: err } = value
  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') return null
  if (!endpoint.startsWith('https://')) return null
  return {
    id: typeof id === 'string' && id.length > 0 ? id : deviceId(endpoint),
    endpoint,
    p256dh,
    auth,
    label: typeof label === 'string' && label.length > 0 ? label : 'A device',
    createdAt: typeof createdAt === 'number' ? createdAt : deps.now(),
    lastPushAt: typeof lastPushAt === 'number' ? lastPushAt : null,
    lastError: typeof err === 'string' ? err : null,
  }
}

/**
 * The key pair is minted on first read and then never changes.
 *
 * Rotating it invalidates every existing subscription silently — the push
 * service keeps accepting the old endpoints and the browser keeps holding
 * them, but our JWT no longer matches the key they were created with. So a
 * pair that fails its self-consistency check is replaced (it was already
 * useless) and everything subscribed against it is dropped with it, rather
 * than left behind to fail forever.
 */
function load(): PushFile {
  if (cached) return cached
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath(), 'utf8'))
  } catch {
    parsed = null
  }
  const vapid = isRecord(parsed) && isRecord(parsed.vapid)
    ? { publicKey: String(parsed.vapid.publicKey ?? ''), privateKey: String(parsed.vapid.privateKey ?? '') }
    : { publicKey: '', privateKey: '' }

  if (isValidVapidKeys(vapid)) {
    const rows = isRecord(parsed) && Array.isArray(parsed.subscriptions) ? parsed.subscriptions : []
    cached = {
      vapid,
      subscriptions: rows.map(readSubscription).filter((s): s is StoredSubscription => s !== null).slice(0, MAX_DEVICES),
    }
    return cached
  }

  cached = { vapid: generateVapidKeys(), subscriptions: [] }
  persist()
  return cached
}

/**
 * Write via a temp file and a rename.
 *
 * The invariant is that there is no half-registered state after a crash: a
 * truncated write here would lose the VAPID key while the browser still holds
 * subscriptions minted against it, and every future push would 403 with no
 * way to notice from the device.
 */
function persist(): void {
  if (!cached) return
  const path = filePath()
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(cached, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
  }
}

function deviceId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16)
}

function toDevice(row: StoredSubscription): PushDevice {
  return {
    id: row.id,
    label: row.label,
    // The host, never the endpoint. A push endpoint is a capability to send
    // to that device, and `push:status` is reachable over the socket.
    service: hostOf(row.endpoint),
    createdAt: row.createdAt,
    lastPushAt: row.lastPushAt,
    lastError: row.lastError,
  }
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'unknown'
  }
}

export function getPushStatus(): PushStatus {
  const file = load()
  return {
    vapidPublicKey: file.vapid.publicKey,
    devices: file.subscriptions.map(toDevice),
    error: lastError,
  }
}

function announce(): PushStatus {
  const status = getPushStatus()
  deps.onStatusChange?.(status)
  return status
}

/**
 * Register a device, or refresh one already registered.
 *
 * Keyed by endpoint: a browser re-subscribing with the same VAPID key gets
 * the same endpoint back, and storing it twice would buzz the phone twice for
 * one event. Registration is a single synchronous mutation followed by a
 * single atomic write, so the "granted permission but not yet persisted"
 * window the client owns has no counterpart here — from this side a
 * subscription either exists or it does not.
 */
export function addSubscription(input: PushSubscriptionInput): PushStatus {
  const file = load()
  if (!input.endpoint.startsWith('https://')) {
    throw new Error('A push endpoint must be an https URL')
  }
  if (!input.keys?.p256dh || !input.keys?.auth) {
    throw new Error('A push subscription must carry both of its keys')
  }
  const id = deviceId(input.endpoint)
  const existing = file.subscriptions.find((row) => row.id === id)
  if (existing) {
    existing.p256dh = input.keys.p256dh
    existing.auth = input.keys.auth
    existing.label = input.label?.slice(0, 60) || existing.label
    existing.lastError = null
  } else {
    if (file.subscriptions.length >= MAX_DEVICES) {
      // Oldest out. A cap that refuses instead would leave the user unable to
      // register the phone in their hand without knowing which row to drop.
      file.subscriptions.sort((a, b) => a.createdAt - b.createdAt).shift()
    }
    file.subscriptions.push({
      id,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      label: input.label?.slice(0, 60) || 'A device',
      createdAt: deps.now(),
      lastPushAt: null,
      lastError: null,
    })
  }
  lastError = null
  persist()
  return announce()
}

/** Forget one device, addressed by its endpoint (what the device knows) or its id. */
export function removeSubscription(endpointOrId: string): PushStatus {
  const file = load()
  const id = endpointOrId.startsWith('https://') ? deviceId(endpointOrId) : endpointOrId
  const before = file.subscriptions.length
  file.subscriptions = file.subscriptions.filter((row) => row.id !== id)
  if (file.subscriptions.length !== before) persist()
  return announce()
}

export function removeAllSubscriptions(): PushStatus {
  const file = load()
  if (file.subscriptions.length === 0) return getPushStatus()
  file.subscriptions = []
  persist()
  return announce()
}

// ── The trigger ───────────────────────────────────────────

/** Last status seen per terminal, so `waiting` fires on entry rather than on repeat. */
const lastStatus = new Map<string, AgentStatusEvent['status']>()
/** When we last notified about a terminal. */
const lastNotifiedAt = new Map<string, number>()

/**
 * Should this transition wake a phone?
 *
 * Pure, and separated from the delivery so the decision can be tested without
 * a key pair, a network or a clock — this predicate IS the feature's promise.
 */
export function shouldNotify(
  event: AgentStatusEvent,
  previous: AgentStatusEvent['status'] | undefined,
  lastAt: number | undefined,
  now: number,
): boolean {
  if (!event.precise) return false
  if (event.status !== 'waiting') return false
  if (previous === 'waiting') return false
  if (lastAt !== undefined && now - lastAt < DEBOUNCE_MS) return false
  return true
}

/** Everything a device is told. Encrypted end to end; the push service sees none of it. */
export interface PushPayload {
  title: string
  body: string
  terminalId: string
  /**
   * Where a tap lands, token included.
   *
   * Carried per message rather than assumed from the service worker's own
   * scope: the access token is minted fresh on every server start, so a
   * worker registered before a restart has a scope that no longer resolves.
   * The URL is only ever as fresh as the message that carried it.
   */
  url: string
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function buildPayload(event: AgentStatusEvent, label: string | null, url: string): PushPayload {
  const where = event.worktreePath.split('/').filter(Boolean).slice(-2).join('/')
  return {
    title: shorten(label ?? 'A session is blocked', 60),
    body: shorten(event.message?.trim() || `Blocked on you — ${where}`, 140),
    terminalId: event.terminalId,
    // The deep link the service worker opens. `PocketApp` reads the fragment
    // and opens straight into that session.
    url: `${url}${url.includes('#') ? '' : '#'}session=${encodeURIComponent(event.terminalId)}`,
  }
}

/**
 * Deliver to every registered device, pruning the ones the push service says
 * are gone.
 *
 * 404 and 410 mean "this endpoint no longer exists" and nothing else does — a
 * 429 or a 502 is Apple having a bad afternoon, and pruning on those would
 * silently unsubscribe every device the user owns at exactly the moment the
 * feature is least able to report it.
 */
export async function deliver(payload: PushPayload): Promise<void> {
  const file = load()
  if (file.subscriptions.length === 0) return
  const body = JSON.stringify(payload)
  const results = await Promise.all(
    // Snapshot: a subscribe or an unsubscribe landing mid-flight must not
    // change what this fan-out is iterating.
    [...file.subscriptions].map(async (row) => ({
      row,
      result: await sendPush(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        body,
        { vapid: { keys: file.vapid, subject: VAPID_SUBJECT }, transport: deps.transport },
      ),
    })),
  )

  const gone = new Set<string>()
  for (const { row, result } of results) {
    if (isGoneStatus(result.status)) {
      gone.add(row.id)
      continue
    }
    row.lastError = result.error
    if (!result.error) row.lastPushAt = deps.now()
  }
  // Re-read: the store may have changed while the requests were in flight, so
  // the prune is applied to what is there NOW, by id.
  const current = load()
  current.subscriptions = current.subscriptions.filter((row) => !gone.has(row.id))
  persist()
  announce()
}

/**
 * The `agent:status` watcher. Registered once by `index.ts`.
 *
 * Errors are swallowed on purpose: this runs inside status reporting, and a
 * push service being unreachable must never be able to stop the sidebar
 * updating.
 */
export function handleAgentStatus(event: AgentStatusEvent, windowId: number): void {
  const previous = lastStatus.get(event.terminalId)
  const now = deps.now()

  if (event.status === 'exited') {
    // The session is over; so is everything keyed by its id. Without this the
    // two maps grow by one entry per session for the life of the process.
    lastStatus.delete(event.terminalId)
    lastNotifiedAt.delete(event.terminalId)
    return
  }
  lastStatus.set(event.terminalId, event.status)

  if (!shouldNotify(event, previous, lastNotifiedAt.get(event.terminalId), now)) return
  const url = deps.targetUrl()
  // Nothing reachable means a tap would land on a dead URL. Better no buzz.
  if (!url) return
  if (load().subscriptions.length === 0) return

  lastNotifiedAt.set(event.terminalId, now)
  void deliver(buildPayload(event, deps.labelFor(windowId, event.terminalId), url)).catch((error: unknown) => {
    lastError = error instanceof Error ? error.message : String(error)
  })
}

/** Exported for tests: forget every in-memory gate and the cached file. */
export function resetPushState(): void {
  cached = null
  lastError = null
  lastStatus.clear()
  lastNotifiedAt.clear()
}
