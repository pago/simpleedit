/**
 * What the tailscale CLI on THIS machine actually accepts.
 *
 * The rest of the suite drives a stub. A stub is written from an understanding
 * of the contract, so it can only ever confirm that understanding — if the
 * removal argv were wrong, every stubbed test would still pass and the failure
 * would appear the first time a user quit the app. This file closes that loop
 * against the real binary.
 *
 * It is non-mutating by construction: the probe is the shipped `OFF_ARGS` with
 * a path that cannot exist spliced in, so the command reaches the removal code
 * and then finds nothing to remove. The argv is derived from the exported
 * constant rather than retyped, so a typo there fails here too.
 *
 * Recorded for 1.102.3, run by hand while the backend was up:
 *
 *     $ tailscale serve --set-path=/x off
 *     error: failed to remove web serve: handler does not exist
 *
 * — the removal code path, which an unrecognised target would never reach.
 * `off` is absent from `tailscale serve --help` even so, which is the whole
 * reason this file exists: the help output lists subcommands and a `<target>`
 * placeholder, never the values that placeholder takes, so absence from it says
 * nothing either way.
 *
 * Skipped unless a CLI is installed AND the backend is `Running`: a stopped
 * tailscaled answers `Tailscale is stopped.` before it validates the target,
 * which cannot tell a good target from a bad one.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { findTailscaleCliSync, parseStatusJson } from '../tailscale'
import { OFF_ARGS } from '../serve'

/** A path no serve config will hold, so the removal is a no-op either way. */
const ABSENT_PATH = '/simpleedit-contract-probe'

function run(cli: string, args: readonly string[]): string {
  try {
    return execFileSync(cli, [...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const failure: { stdout?: unknown; stderr?: unknown } =
      typeof error === 'object' && error !== null ? error : {}
    return `${String(failure.stderr ?? '')}\n${String(failure.stdout ?? '')}`
  }
}

const cli = findTailscaleCliSync()
const backendState = cli ? parseStatusJson(run(cli, ['status', '--json']))?.backendState ?? null : null
const canProbe = cli !== null && backendState === 'Running'

describe.skipIf(!canProbe)('the installed tailscale CLI', () => {
  it('understands the removal form this app ships', () => {
    // Splice the absent path in ahead of the target, so `--https=443` and the
    // `off` target are both exactly what teardown uses.
    const probe = [...OFF_ARGS.slice(0, -1), `--set-path=${ABSENT_PATH}`, OFF_ARGS[OFF_ARGS.length - 1]]
    const output = run(cli!, probe)

    // Reaching "no such handler" proves `off` was understood as a removal: an
    // unrecognised target would have been taken as something to SERVE instead.
    expect(output).toMatch(/failed to remove|does not exist/i)
    expect(output).not.toMatch(/unknown subcommand|invalid argument format/i)
  })

  it('reports its serve config in the shape the reconciler parses', () => {
    const output = run(cli!, ['serve', 'status', '--json'])
    expect(() => JSON.parse(output)).not.toThrow()
  })
})

describe.skipIf(canProbe)('the installed tailscale CLI (not probed)', () => {
  it('says why it could not be checked, rather than passing silently', () => {
    // A skipped contract check must not read as a green one.
    console.log(
      `[contract] tailscale CLI: ${cli ?? 'not found'}; backend: ${backendState ?? 'unknown'} — probe needs a Running backend.`,
    )
    expect(canProbe).toBe(false)
  })
})
