/**
 * Finding Tailscale, and asking it what it knows.
 *
 * `interfaces.ts` recognises a Tailscale *interface* — enough to decide what
 * may be bound, and nothing more. It cannot name the node, cannot say whether
 * HTTPS certificates exist, and cannot drive Serve. That needs the CLI.
 *
 * ── Where the CLI lives ───────────────────────────────────────────────────
 * Three installs, three answers, and the difference matters because the wrong
 * one fails silently:
 *
 *  - **Standalone macOS app** — the binary inside the bundle, plus a
 *    `/usr/local/bin/tailscale` shim it drops on first launch.
 *  - **Homebrew** — `/opt/homebrew/bin` on Apple silicon, `/usr/local/bin` on
 *    Intel, and on `$PATH` either way.
 *  - **Mac App Store** — sandboxed, and historically ships no CLI reachable
 *    from outside it. The bundle path still EXISTS, so probing for the file is
 *    not enough; the receipt at `Contents/_MASReceipt/receipt` is what tells
 *    the two apart, and it is used to explain the failure rather than to
 *    pre-judge it. A newer MAS build whose CLI does answer is used normally.
 *
 * ── Nothing here logs its output ──────────────────────────────────────────
 * `serve status` carries the proxy target, and this app's target is a URL a
 * bearer token was minted for. Errors are returned as values.
 */
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveExecutable } from '../lib/shell-path'
import type { TailscaleStatus } from '../../shared/ipc-types'

/** The bundle the standalone and App Store builds share. */
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const MAS_RECEIPT = '/Applications/Tailscale.app/Contents/_MASReceipt/receipt'

/**
 * Absolute paths worth trying before falling back to a login shell.
 *
 * Ordered by how likely the entry is to be a working CLI, not by how likely it
 * is to exist. When the bundle is an App Store build its binary goes LAST:
 * it is the one candidate that can exist and still not answer, so a Homebrew
 * install alongside it should win rather than be shadowed.
 */
function absoluteCandidates(): string[] {
  if (process.platform === 'win32') {
    // The installer's own location, so the synchronous quit-time teardown has
    // somewhere to look: it deliberately skips the login-shell `$PATH` probe.
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    return programFiles
      .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
      .map((dir) => join(dir, 'Tailscale', 'tailscale.exe'))
  }
  if (process.platform !== 'darwin') return ['/usr/bin/tailscale', '/usr/local/bin/tailscale']
  const brew = ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
  return isAppStoreBuild() ? [...brew, MAC_APP_CLI] : [MAC_APP_CLI, ...brew]
}

/** Is the installed Tailscale.app the sandboxed App Store build? */
export function isAppStoreBuild(): boolean {
  return process.platform === 'darwin' && existsSync(MAS_RECEIPT)
}

export interface TailscaleRun {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run the CLI. Never throws: a missing binary, a non-zero exit and a timeout
 * all come back as a `TailscaleRun` the caller can read, because every one of
 * them is a state the pane has something useful to say about.
 */
export function runTailscale(cli: string, args: readonly string[], timeoutMs = 10_000): Promise<TailscaleRun> {
  return new Promise((resolve) => {
    execFile(cli, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
}

/**
 * The CLI to drive, or null.
 *
 * `SIMPLEEDIT_TAILSCALE_CLI` overrides everything — an escape hatch for an
 * install in none of the usual places, and the seam the tests drive a stub
 * through, so they exercise the real spawn path rather than a mocked one.
 */
export async function findTailscaleCli(): Promise<string | null> {
  const override = process.env.SIMPLEEDIT_TAILSCALE_CLI
  if (override) return existsSync(override) ? override : null
  for (const candidate of absoluteCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return await resolveExecutable('tailscale')
}

/** The fields of `tailscale status --json` this app reads. */
interface RawStatus {
  BackendState?: unknown
  MagicDNSSuffix?: unknown
  CertDomains?: unknown
  Self?: { DNSName?: unknown } | null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** MagicDNS names are fully qualified — `host.tailnet.ts.net.` — and URLs are not. */
function stripTrailingDot(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1) : name
}

/**
 * Parse `tailscale status --json`. Exported for tests, and deliberately total:
 * every field is optional in the wire format and a missing one means "unknown",
 * never a throw inside a status probe.
 */
export function parseStatusJson(stdout: string): {
  backendState: string | null
  dnsName: string | null
  magicDnsSuffix: string | null
  certDomains: string[]
} | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const status = raw as RawStatus
  const dnsName = asString(status.Self?.DNSName)
  const certDomains = Array.isArray(status.CertDomains)
    ? status.CertDomains.filter((d): d is string => typeof d === 'string')
    : []
  return {
    backendState: asString(status.BackendState),
    dnsName: dnsName ? stripTrailingDot(dnsName) : null,
    magicDnsSuffix: asString(status.MagicDNSSuffix),
    certDomains,
  }
}

const MAS_HINT =
  'The Mac App Store build of Tailscale is sandboxed and does not expose a command line this app can drive. Install the standalone app from tailscale.com/download, or run `brew install tailscale`, then re-check.'

/** Where to get a CLI, which is not the same advice on every platform. */
function installAdvice(): string {
  if (process.platform === 'darwin') {
    return 'Install the standalone macOS app from tailscale.com/download, or run `brew install tailscale`'
  }
  if (process.platform === 'win32') return 'Install Tailscale for Windows from tailscale.com/download'
  return 'Install Tailscale from tailscale.com/download, or through your package manager'
}

/** No CLI at all. The App Store build is the one case with a specific answer. */
export function missingCliHint(appStoreBuild: boolean): string {
  return appStoreBuild ? MAS_HINT : `No tailscale command was found. ${installAdvice()}, then re-check.`
}

/**
 * A CLI that is there and will not answer.
 *
 * On an App Store install that is the expected outcome, and the hint has to say
 * so — "did not answer" alone sends the user looking for a fault that is really
 * a packaging choice.
 */
export function unusableCliHint(cli: string, appStoreBuild: boolean, detail: string): string {
  if (appStoreBuild) return MAS_HINT
  return `${cli} did not answer${detail ? `: ${detail}` : '.'}`
}

/**
 * Everything the pane needs to decide what to offer and what to explain.
 *
 * Two probes, not one: `status --json` answers all of it, so a second call
 * would only be a second chance to disagree with the first.
 */
export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  const appStoreBuild = isAppStoreBuild()
  const cli = await findTailscaleCli()
  if (!cli) {
    return {
      cli: null,
      cliUsable: false,
      backendState: null,
      dnsName: null,
      httpsReady: false,
      hint: missingCliHint(appStoreBuild),
    }
  }

  const run = await runTailscale(cli, ['status', '--json'])
  const parsed = run.code === 0 ? parseStatusJson(run.stdout) : null
  if (!parsed) {
    // `cli` is what we WOULD run, and on Windows `resolveExecutable` hands
    // back a bare name it never verified — so a machine with no Tailscale at
    // all still produces a non-null path here. `cliUsable` is the field that
    // means "this answered", and it is what the pane gates on.
    return {
      cli,
      cliUsable: false,
      backendState: null,
      dnsName: null,
      httpsReady: false,
      hint: unusableCliHint(cli, appStoreBuild, run.stderr.trim() || run.stdout.trim()),
    }
  }

  const httpsReady = parsed.dnsName !== null && parsed.certDomains.includes(parsed.dnsName)
  return {
    cli,
    cliUsable: true,
    backendState: parsed.backendState,
    dnsName: parsed.dnsName,
    httpsReady,
    hint: statusHint(parsed.backendState, parsed.dnsName, httpsReady),
  }
}

function statusHint(backendState: string | null, dnsName: string | null, httpsReady: boolean): string | null {
  if (backendState !== 'Running') {
    return `Tailscale is installed but not connected${backendState ? ` (${backendState})` : ''}. Start it and sign in, then re-check.`
  }
  if (!dnsName) {
    return 'Tailscale is running but this node has no MagicDNS name, so there is no HTTPS address to hand a phone. Enable MagicDNS for the tailnet.'
  }
  if (!httpsReady) {
    return 'HTTPS certificates are not issued for this node. Turn on HTTPS for the tailnet in the admin console — it is a one-time switch, and Serve needs it.'
  }
  return null
}

/**
 * The CLI, resolved without awaiting anything.
 *
 * `before-quit` is synchronous, and a serve mapping has to be removed there —
 * an awaited teardown at quit is a promise nothing will settle. This skips the
 * login-shell `$PATH` probe, which is the only asynchronous step; an install
 * that only exists on `$PATH` is therefore cleaned up at the next launch
 * instead, which is what the persisted claim is for.
 */
export function findTailscaleCliSync(): string | null {
  const override = process.env.SIMPLEEDIT_TAILSCALE_CLI
  if (override) return existsSync(override) ? override : null
  return absoluteCandidates().find((candidate) => existsSync(candidate)) ?? null
}
