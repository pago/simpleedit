/**
 * `tailscale serve`, owned by the server it points at.
 *
 * Serve puts SimpleEdit on `https://<node>.<tailnet>.ts.net` with a real
 * certificate, which is what makes the phone surface work at all: without a
 * secure context `getUserMedia` never opens and dictation is dead. It is also
 * the one piece of this feature that writes state OUTSIDE the app — into
 * tailscaled, where it survives us — so the whole module is about lifetime.
 *
 * ── The mapping's lifetime is the server's ────────────────────────────────
 * Created when the server starts listening, re-pointed when its port changes,
 * removed when it stops — at a toggle, at quit, and at the next launch after a
 * crash. A mapping that outlives its server points at a dead port, or worse at
 * a recycled one: the port is ephemeral (`port: 0`), so the number tailscaled
 * is holding can belong to something else entirely by the time a phone asks
 * for it.
 *
 * ── Ownership begins BEFORE the command, not after it ─────────────────────
 * `claimedPort` is set before `serve` is spawned, and the port is persisted in
 * the same breath. A serve that is killed halfway can still have written the
 * config, so "we succeeded" is the wrong moment to start owning it. The gap
 * that matters is between the user opting in and the mapping existing: a
 * toggle-off landing in it queues behind the in-flight command and tears the
 * mapping down as soon as it exists, rather than finding nothing and no-oping.
 *
 * ── The root, never the token path ────────────────────────────────────────
 * `buildServeArgs` refuses to hand the access token to tailscaled. Mounting
 * `/<token>/` at `/` would serve the app with no token in the URL — the app's
 * own auth layer gone, leaving only Tailscale device auth. It is the shortcut
 * a person reaches for when running this by hand, it reads as a convenience,
 * and it is a downgrade. So it is a check, not a comment.
 */
import { execFileSync } from 'child_process'
import { getRemoteConfig, setRemoteConfig } from './config'
import { findTailscaleCli, findTailscaleCliSync, getTailscaleStatus, runTailscale } from './tailscale'
import type { TailscaleServeStatus } from '../../shared/ipc-types'

/** Serve talks to tailscaled over a local socket; slow here means wedged. */
const SERVE_TIMEOUT_MS = 20_000

/** Quit is not a place to wait. Long enough for a local socket, no longer. */
const SYNC_TIMEOUT_MS = 3_000

/** What we want to be true. Replaced synchronously; acted on in `step`. */
let desired: { port: number; token: string } | null = null

/**
 * The port we are obliged to clean up after, or null when we own nothing.
 * Distinct from `publishedUrl`: a failed `serve` can leave a mapping behind,
 * so the obligation outlasts the success.
 */
let claimedPort: number | null = null

/** Set only once `serve` has actually succeeded. Carries the access token. */
let publishedUrl: string | null = null

let enableUrl: string | null = null
let lastError: string | null = null
/** Requests that have been made and not yet run. `busy` is simply "any left". */
let pending = 0
let busy = false

/** Serialised, so two toggles cannot each run a command against the other's state. */
let chain: Promise<void> = Promise.resolve()

export function getServeStatus(): TailscaleServeStatus {
  return {
    active: publishedUrl !== null,
    port: claimedPort,
    url: publishedUrl,
    busy,
    enableUrl,
    error: lastError,
  }
}

/**
 * The argv for the serve command, with the one argument it must never contain
 * checked for real.
 *
 * The target is the server's ROOT. Everything below it still needs the token,
 * which is the app's only authorisation boundary.
 */
export function buildServeArgs(port: number, token: string): readonly string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Refusing to serve port ${port}`)
  }
  const args = ['serve', '--bg', `http://127.0.0.1:${port}`]
  if (token.length > 0 && args.some((arg) => arg.includes(token))) {
    throw new Error('Refusing to hand the remote access token to tailscale serve')
  }
  return args
}

/** Removing the handler we install. Idempotent by intent; see `isAlreadyGone`. */
const OFF_ARGS = ['serve', '--https=443', 'off'] as const

/** `off` against a handler that is not there is success, not failure. */
function isAlreadyGone(text: string): boolean {
  return /handler does not exist|no serve config|not currently serving/i.test(text)
}

/**
 * The node-specific URL buried in `Serve is not enabled on your tailnet.`
 *
 * It names the node, so it cannot be derived — and the CLI wraps it, which is
 * how a real terminal truncated it and left the user with a dead end. Pulled
 * out here so the pane can render it as a link.
 */
export function parseServeFailure(text: string): { message: string; enableUrl: string | null } {
  const message = text.trim().replace(/\s*\n\s*/g, ' ')
  if (!/not enabled|to enable|visit/i.test(message)) return { message, enableUrl: null }
  const match = /https:\/\/[^\s<>"')\]]+/.exec(message)
  const url = match ? match[0].replace(/[.,;]+$/, '') : null
  return { message, enableUrl: url }
}

/** Remember the port across a crash, so an orphaned mapping is still ours to remove. */
function rememberClaim(port: number): void {
  const config = getRemoteConfig()
  if (config.servePort === port) return
  setRemoteConfig({ ...config, servePort: port })
}

function forgetClaim(): void {
  const config = getRemoteConfig()
  if (config.servePort === 0) return
  setRemoteConfig({ ...config, servePort: 0 })
}

/**
 * Ask for a serve mapping on `port`, or for none at all.
 *
 * `desired` is assigned before anything is awaited, so a caller that changes
 * its mind while a command is running is honoured by the step that command is
 * already queued ahead of, rather than racing it.
 */
export function applyServe(next: { port: number; token: string } | null): Promise<TailscaleServeStatus> {
  desired = next
  pending += 1
  busy = true
  chain = chain.then(step, step)
  return chain.then(getServeStatus, getServeStatus)
}

async function step(): Promise<void> {
  try {
    // Read here, not at call time: whatever the latest intent is, that is the
    // one this step implements. Superseded requests collapse into a no-op.
    const want = desired
    if (want && claimedPort === want.port && publishedUrl !== null) return
    if (claimedPort !== null) await removeMapping()
    if (!want) {
      lastError = null
      enableUrl = null
      return
    }
    await installMapping(want.port, want.token)
  } finally {
    // Only the last step in the chain clears it; an intermediate one still has
    // work queued behind it, and the pane should stay disabled throughout.
    pending -= 1
    busy = pending > 0
  }
}

async function installMapping(port: number, token: string): Promise<void> {
  enableUrl = null
  const status = await getTailscaleStatus()
  if (!status.cli) {
    lastError = status.hint
    return
  }
  if (!status.dnsName) {
    lastError = status.hint ?? 'Tailscale has no MagicDNS name for this node.'
    return
  }
  // Short-circuited before the command, and not only to save a spawn: a
  // stopped backend answers `serve` with a bare "Tailscale is stopped.", while
  // the status hint names the state and what to do about it. No command runs,
  // so no claim is taken.
  if (status.backendState !== 'Running') {
    lastError = status.hint ?? `Tailscale is not connected (${status.backendState ?? 'unknown'}).`
    return
  }

  const args = buildServeArgs(port, token)
  // Owned from here. The command below can be killed after tailscaled has
  // already written the config, so the obligation starts before the spawn and
  // is persisted before it too — a crash in the next few milliseconds must
  // still leave something the next launch can clean up.
  claimedPort = port
  rememberClaim(port)

  const run = await runTailscale(status.cli, args, SERVE_TIMEOUT_MS)
  if (run.code !== 0) {
    const failure = parseServeFailure(`${run.stderr}\n${run.stdout}`)
    lastError = failure.message || 'tailscale serve failed.'
    enableUrl = failure.enableUrl
    publishedUrl = null
    return
  }
  lastError = null
  enableUrl = null
  publishedUrl = `https://${status.dnsName}/${token}/`
}

async function removeMapping(): Promise<void> {
  const cli = await findTailscaleCli()
  if (!cli) {
    // Nothing can be run, and holding the claim forever would mean never
    // starting a new one. The persisted port survives for the next launch.
    claimedPort = null
    publishedUrl = null
    return
  }
  const run = await runTailscale(cli, OFF_ARGS, SERVE_TIMEOUT_MS)
  if (run.code !== 0 && !isAlreadyGone(`${run.stderr}\n${run.stdout}`)) {
    lastError = parseServeFailure(`${run.stderr}\n${run.stdout}`).message
    publishedUrl = null
    // Claim kept: the mapping is still out there, and the next attempt — or the
    // next launch — has to try again.
    return
  }
  claimedPort = null
  publishedUrl = null
  forgetClaim()
}

/**
 * Remove the mapping synchronously, for `before-quit` and `window-all-closed`.
 *
 * Both of those tear down every server a client could attach to, so a mapping
 * left behind would point at nothing. An `await` in either handler never
 * settles, which is why this exists at all.
 */
export function stopServeSync(): void {
  desired = null
  publishedUrl = null
  enableUrl = null
  if (claimedPort === null) return
  const cli = findTailscaleCliSync()
  claimedPort = null
  if (!cli) return
  try {
    execFileSync(cli, [...OFF_ARGS], { timeout: SYNC_TIMEOUT_MS, stdio: 'ignore' })
  } catch {
    /* the persisted claim is what covers a failure here */
  }
  forgetClaim()
}

/**
 * Remove a mapping left behind by a crash, at launch, before anything starts.
 *
 * The previous server is definitively gone, so any mapping we recorded points
 * at a dead port. It is removed only when tailscaled still shows OUR target —
 * a person who repointed serve by hand in the meantime keeps their mapping.
 */
export async function reclaimAbandonedServe(): Promise<void> {
  const port = getRemoteConfig().servePort
  if (!port) return
  const cli = await findTailscaleCli()
  if (!cli) return
  const run = await runTailscale(cli, ['serve', 'status', '--json'])
  if (run.code !== 0) return
  if (!serveTargetsPort(run.stdout, port)) {
    forgetClaim()
    return
  }
  claimedPort = port
  await removeMapping()
}

/** The `Web` section of `tailscale serve status --json`. */
interface RawServeStatus {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> } | null> | null
}

/**
 * Does the live serve config still point at the loopback port we recorded?
 *
 * Exported for tests. The comparison is on the proxy target, because that is
 * the only thing that identifies the mapping as ours.
 */
export function serveTargetsPort(stdout: string, port: number): boolean {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return false
  }
  if (typeof raw !== 'object' || raw === null) return false
  const web = (raw as RawServeStatus).Web
  if (!web) return false
  const target = `http://127.0.0.1:${port}`
  for (const host of Object.values(web)) {
    for (const handler of Object.values(host?.Handlers ?? {})) {
      if (handler?.Proxy === target) return true
    }
  }
  return false
}

/** Test seam: forget everything this module is holding. */
export function resetServeStateForTests(): void {
  desired = null
  claimedPort = null
  publishedUrl = null
  enableUrl = null
  lastError = null
  pending = 0
  busy = false
  chain = Promise.resolve()
}
