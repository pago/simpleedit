import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RemoteAccessConfig } from '../../../shared/ipc-types'

/**
 * The config is where the crash-recovery claim lives, so it is a real value
 * here rather than a spy: a test that never reads `servePort` back could not
 * tell a claim that is written from one that is not.
 */
let config: RemoteAccessConfig
vi.mock('../config', () => ({
  getRemoteConfig: () => config,
  setRemoteConfig: (next: RemoteAccessConfig) => { config = next },
}))

import {
  applyServe,
  buildServeArgs,
  getServeStatus,
  parseServeFailure,
  reclaimAbandonedServe,
  resetServeStateForTests,
  serveTargetsPort,
  stopServeSync,
} from '../serve'

const TOKEN = '9f3c0a7e5b1d4826aa11cc22dd33ee44ff5566778899aabbccddeeff00112233'

const STATUS_JSON = JSON.stringify({
  BackendState: 'Running',
  MagicDNSSuffix: 'tail050858.ts.net',
  CertDomains: ['mac.tail050858.ts.net'],
  Self: { DNSName: 'mac.tail050858.ts.net.' },
})

/** `tailscale serve` when the tailnet has never had Serve switched on. */
const NOT_ENABLED = `Serve is not enabled on your tailnet.
To enable, visit:

    https://login.tailscale.com/f/serve?node=nfvSEnrBQr11CNTRL

`

let fixtures = ''
let stub = ''
let log = ''
/** The stub's stand-in for tailscaled's serve config: the port it proxies, or empty. */
let state = ''

/** The port the live (fake) serve config currently points at, or null. */
function liveTarget(): number | null {
  if (!existsSync(state)) return null
  const raw = readFileSync(state, 'utf8').trim()
  return raw ? Number(raw) : null
}

/** Every argv the stub was invoked with, one call per line. */
function calls(): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(() => {
  config = { enabled: true, host: '127.0.0.1', port: 0, sttModelPath: '', serveEnabled: true, servePort: 0 }
  fixtures = mkdtempSync(join(tmpdir(), 'se-serve-'))
  stub = join(fixtures, 'tailscale')
  log = join(fixtures, 'calls.log')
  state = join(fixtures, 'serve-state')
  // A tailscale that actually HOLDS the mapping: `serve --bg` records the
  // port, `off` clears it, `serve status --json` renders whatever is there.
  // Without that state a test cannot tell "we removed our own mapping" from
  // "we removed somebody else's".
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1 $2" = "status --json" ]; then cat <<'JSON'
${STATUS_JSON}
JSON
  exit 0
fi
if [ "$1 $2" = "serve status" ]; then
  if [ -n "$TS_STUB_STATUS_FAIL" ]; then echo "failed to connect to local tailscaled" >&2; exit 1; fi
  if [ -s "${state}" ]; then
    printf '{"Web":{"mac.tail050858.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:%s"}}}}}' "$(cat ${state})"
  else
    echo '{}'
  fi
  exit 0
fi
if [ "$1 $2" = "serve --bg" ]; then
  if [ -n "$TS_STUB_SERVE_FAIL" ]; then cat "$TS_STUB_SERVE_FAIL" >&2; exit 1; fi
  if [ -n "$TS_STUB_SERVE_SLOW" ]; then touch "$TS_STUB_SERVE_SLOW"; sleep 0.5; fi
  printf '%s' "\${3##*:}" > "${state}"
  exit 0
fi
if [ "$1 $2 $3" = "serve --https=443 off" ]; then
  if [ -n "$TS_STUB_OFF_FAIL" ]; then echo "$TS_STUB_OFF_FAIL" >&2; exit 1; fi
  if [ ! -s "${state}" ]; then echo "error: failed to remove web serve: handler does not exist" >&2; exit 1; fi
  rm -f "${state}"
  exit 0
fi
exit 0
`,
    'utf8',
  )
  chmodSync(stub, 0o755)
  process.env.SIMPLEEDIT_TAILSCALE_CLI = stub
  resetServeStateForTests()
})

afterEach(() => {
  delete process.env.SIMPLEEDIT_TAILSCALE_CLI
  delete process.env.TS_STUB_SERVE_FAIL
  delete process.env.TS_STUB_SERVE_STATUS
  delete process.env.TS_STUB_SERVE_SLOW
  delete process.env.TS_STUB_OFF_FAIL
  delete process.env.TS_STUB_STATUS_FAIL
  rmSync(fixtures, { recursive: true, force: true })
})

describe('buildServeArgs', () => {
  it('proxies the server root, so the token is still required on every request', () => {
    expect(buildServeArgs(52123, TOKEN)).toEqual(['serve', '--bg', 'http://127.0.0.1:52123'])
  })

  it('refuses to hand the access token to tailscaled', () => {
    // The guard is on the argv, not on the caller's intent: this is what fires
    // if anyone ever passes the full URL — which mounts `/<token>/` at `/` and
    // silently removes the app's only authorisation boundary.
    expect(() => buildServeArgs(52123, '52123')).toThrow(/Refusing to hand the remote access token/)
  })

  it('refuses a port that is not a port', () => {
    expect(() => buildServeArgs(0, TOKEN)).toThrow(/Refusing to serve/)
    expect(() => buildServeArgs(70000, TOKEN)).toThrow(/Refusing to serve/)
  })
})

describe('parseServeFailure', () => {
  it('pulls the node-specific enable link out of the wrapped CLI message', () => {
    const parsed = parseServeFailure(NOT_ENABLED)
    expect(parsed.enableUrl).toBe('https://login.tailscale.com/f/serve?node=nfvSEnrBQr11CNTRL')
    expect(parsed.message).toContain('Serve is not enabled on your tailnet.')
  })

  it('leaves an unrelated failure without a link', () => {
    expect(parseServeFailure('failed to connect to local tailscaled').enableUrl).toBeNull()
  })

  it('does not mistake a documentation link for the admin console', () => {
    // Over-firing is the damaging direction: the pane renders the link and the
    // real message is what gets lost.
    const parsed = parseServeFailure(
      'error: HTTPS must be enabled first; visit https://tailscale.com/kb/1153/enabling-https',
    )
    expect(parsed.enableUrl).toBeNull()
    expect(parsed.message).toContain('HTTPS must be enabled first')
  })
})

describe('applyServe', () => {
  it('publishes an HTTPS URL and never puts the token on the command line', async () => {
    const status = await applyServe({ port: 52123, token: TOKEN })
    expect(status.active).toBe(true)
    expect(status.url).toBe(`https://mac.tail050858.ts.net/${TOKEN}/`)
    expect(calls()).toContain('serve --bg http://127.0.0.1:52123')
    for (const call of calls()) expect(call).not.toContain(TOKEN)
  })

  it('records the claim before the mapping exists, so a crash leaves something to clean up', async () => {
    await applyServe({ port: 52123, token: TOKEN })
    expect(config.servePort).toBe(52123)
  })

  it('follows the ephemeral port: the old mapping is removed before the new one', async () => {
    await applyServe({ port: 52123, token: TOKEN })
    await applyServe({ port: 61000, token: TOKEN })
    // The status read between them is the ownership check: `off` is only ever
    // run against a config that still shows our own target.
    expect(calls().filter((c) => c.startsWith('serve'))).toEqual([
      'serve --bg http://127.0.0.1:52123',
      'serve status --json',
      'serve --https=443 off',
      'serve --bg http://127.0.0.1:61000',
    ])
    expect(getServeStatus().url).toBe(`https://mac.tail050858.ts.net/${TOKEN}/`)
    expect(config.servePort).toBe(61000)
  })

  it('removes the mapping and clears the claim when asked for nothing', async () => {
    await applyServe({ port: 52123, token: TOKEN })
    const status = await applyServe(null)
    expect(status.active).toBe(false)
    expect(calls()).toContain('serve --https=443 off')
    expect(config.servePort).toBe(0)
  })

  it('never creates a mapping the user changed their mind about before it started', async () => {
    // Both requests land before either has run a command, so the opt-in
    // collapses entirely — the cheapest correct outcome, and the one that
    // proves the intent is read when the step runs rather than when it was
    // queued.
    const first = applyServe({ port: 52123, token: TOKEN })
    const second = applyServe(null)
    await Promise.all([first, second])
    expect(getServeStatus().active).toBe(false)
    expect(getServeStatus().port).toBeNull()
    expect(calls()).toEqual([])
    expect(config.servePort).toBe(0)
  })

  it('tears down a mapping created while the user was already opting out', async () => {
    // The real gap: `serve` is running, tailscaled may already have written
    // the config, and the toggle goes off. The teardown has to queue behind
    // the command in flight rather than find nothing and no-op.
    process.env.TS_STUB_SERVE_SLOW = join(fixtures, 'serving')

    const first = applyServe({ port: 52123, token: TOKEN })
    await waitFor(() => existsSync(join(fixtures, 'serving')))
    const second = applyServe(null)
    await Promise.all([first, second])

    expect(calls().filter((c) => c.startsWith('serve'))).toEqual([
      'serve --bg http://127.0.0.1:52123',
      'serve status --json',
      'serve --https=443 off',
    ])
    expect(getServeStatus().active).toBe(false)
    expect(getServeStatus().port).toBeNull()
    expect(config.servePort).toBe(0)
  })

  it('says why rather than running a command against a stopped backend', async () => {
    // Real output from a stopped tailscaled is a bare "Tailscale is stopped.";
    // the status hint says what to do about it, and no claim is taken because
    // no command ran.
    writeFileSync(
      stub,
      `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1 $2" = "status --json" ]; then echo '{"BackendState":"Stopped","Self":{"DNSName":"mac.tail050858.ts.net."}}'; exit 0; fi\necho "Tailscale is stopped." >&2\nexit 1\n`,
      'utf8',
    )
    chmodSync(stub, 0o755)

    const status = await applyServe({ port: 52123, token: TOKEN })
    expect(status.active).toBe(false)
    expect(status.error).toMatch(/not connected \(Stopped\)/)
    expect(calls()).toEqual(['status --json'])
    expect(config.servePort).toBe(0)
  })

  it('surfaces the enable link when Serve is off for the tailnet', async () => {
    const failure = join(fixtures, 'fail.txt')
    writeFileSync(failure, NOT_ENABLED, 'utf8')
    process.env.TS_STUB_SERVE_FAIL = failure

    const status = await applyServe({ port: 52123, token: TOKEN })
    expect(status.active).toBe(false)
    expect(status.url).toBeNull()
    expect(status.enableUrl).toBe('https://login.tailscale.com/f/serve?node=nfvSEnrBQr11CNTRL')
    // The claim is kept: a failed command can still have written config.
    expect(config.servePort).toBe(52123)
  })

  it('still releases the claim after a failed serve, rather than stranding it', async () => {
    const failure = join(fixtures, 'fail.txt')
    writeFileSync(failure, NOT_ENABLED, 'utf8')
    process.env.TS_STUB_SERVE_FAIL = failure
    await applyServe({ port: 52123, token: TOKEN })

    delete process.env.TS_STUB_SERVE_FAIL
    await applyServe(null)
    expect(liveTarget()).toBeNull()
    expect(config.servePort).toBe(0)
  })

  it('re-installs when the token changes on the same port', async () => {
    // The token is minted fresh on every server start, so a restart handed the
    // same ephemeral port must not be mistaken for "already correct" — the QR
    // would keep encoding a token that no longer opens anything.
    await applyServe({ port: 52123, token: TOKEN })
    const next = 'b'.repeat(64)
    const status = await applyServe({ port: 52123, token: next })
    expect(status.url).toBe(`https://mac.tail050858.ts.net/${next}/`)
  })

  it('leaves a mapping somebody repointed by hand alone', async () => {
    await applyServe({ port: 52123, token: TOKEN })
    // Someone points serve at their own dev server.
    writeFileSync(state, '3000', 'utf8')

    await applyServe(null)
    expect(liveTarget()).toBe(3000)
    expect(config.servePort).toBe(0)
  })
})

describe('stopServeSync', () => {
  it('removes the mapping without awaiting anything, for the quit path', async () => {
    await applyServe({ port: 52123, token: TOKEN })
    stopServeSync()
    expect(liveTarget()).toBeNull()
    expect(getServeStatus().active).toBe(false)
    expect(config.servePort).toBe(0)
  })

  it('does nothing when no mapping is owned', () => {
    stopServeSync()
    expect(calls()).toEqual([])
  })

  it('keeps the claim when the removal fails, so the next launch can reconcile', async () => {
    // The failure this exists for: tailscaled is wedged, `off` times out or
    // errors, and the mapping is still live. Releasing the claim here is
    // unrecoverable — the next launch reads `servePort: 0`, reconciles
    // nothing, and the mapping outlives its port forever.
    await applyServe({ port: 52123, token: TOKEN })
    process.env.TS_STUB_OFF_FAIL = 'tailscaled is not responding'

    stopServeSync()
    expect(liveTarget()).toBe(52123)
    expect(config.servePort).toBe(52123)
  })

  it('keeps the claim when it cannot even read the serve config', async () => {
    await applyServe({ port: 52123, token: TOKEN })
    process.env.TS_STUB_STATUS_FAIL = '1'

    stopServeSync()
    // Nothing is removed on a guess: a tailscaled that will not answer a
    // status read will not answer `off` either, and the claim is what turns
    // that into a problem the next launch solves.
    expect(liveTarget()).toBe(52123)
    expect(config.servePort).toBe(52123)
  })

  it('keeps the claim when quit lands during an in-flight install', async () => {
    // `claimedPort` is taken before the spawn, so quit can run `off` while the
    // install is still talking to tailscaled — and the install then re-creates
    // the handler behind it. Releasing the claim here strands that mapping.
    process.env.TS_STUB_SERVE_SLOW = join(fixtures, 'serving')
    const install = applyServe({ port: 52123, token: TOKEN })
    await waitFor(() => existsSync(join(fixtures, 'serving')))

    stopServeSync()
    await install
    expect(config.servePort).toBe(52123)
  })

  it('does not remove a mapping somebody repointed by hand', async () => {
    await applyServe({ port: 52123, token: TOKEN })
    writeFileSync(state, '3000', 'utf8')

    stopServeSync()
    expect(liveTarget()).toBe(3000)
    expect(config.servePort).toBe(0)
  })
})

describe('serveTargetsPort', () => {
  const live = JSON.stringify({
    Web: { 'mac.tail050858.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:52123' } } } },
  })

  it('recognises our own mapping by its proxy target', () => {
    expect(serveTargetsPort(live, 52123)).toBe(true)
    expect(serveTargetsPort(live, 61000)).toBe(false)
  })

  it('says no rather than throwing on output it cannot parse', () => {
    expect(serveTargetsPort('not json', 52123)).toBe(false)
    expect(serveTargetsPort('{}', 52123)).toBe(false)
  })
})

describe('reclaimAbandonedServe', () => {
  it('removes a mapping a previous run left pointing at a dead port', async () => {
    config = { ...config, servePort: 52123 }
    writeFileSync(state, '52123', 'utf8')

    await reclaimAbandonedServe()
    expect(liveTarget()).toBeNull()
    expect(config.servePort).toBe(0)
  })

  it('leaves a mapping somebody else repointed alone', async () => {
    config = { ...config, servePort: 52123 }
    writeFileSync(state, '3000', 'utf8')

    await reclaimAbandonedServe()
    expect(liveTarget()).toBe(3000)
    expect(config.servePort).toBe(0)
  })

  it('keeps the claim when tailscaled will not say what it is holding', async () => {
    config = { ...config, servePort: 52123 }
    writeFileSync(state, '52123', 'utf8')
    process.env.TS_STUB_STATUS_FAIL = '1'

    await reclaimAbandonedServe()
    expect(liveTarget()).toBe(52123)
    expect(config.servePort).toBe(52123)
  })

  it('does nothing at all when no claim was recorded', async () => {
    await reclaimAbandonedServe()
    expect(calls()).toEqual([])
  })
})
