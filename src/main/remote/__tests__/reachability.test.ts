import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TunnelStatus } from '../../../shared/ipc-types'
import type { ReachabilityProvider } from '../reachability'

const idle: TunnelStatus = { active: false, port: null, url: null, busy: false, enableUrl: null, error: null }

function fakeProvider(id: ReachabilityProvider['id'], trustsForwardedHeaders: boolean): ReachabilityProvider {
  return {
    id,
    trustsForwardedHeaders,
    apply: vi.fn(() => idle),
    withdraw: vi.fn(() => idle),
    status: vi.fn(() => idle),
    stopSync: vi.fn(),
    reclaimAbandoned: vi.fn(async () => {}),
    onChange: () => () => {},
  }
}

const tailscale = fakeProvider('tailscale-serve', true)
const tunnel: ReachabilityProvider = { ...fakeProvider('opentunnel', false), forget: vi.fn(() => idle) }
vi.mock('../serve', () => ({ tailscaleServe: tailscale }))
vi.mock('../opentunnel', () => ({ openTunnel: tunnel }))

const { applyExposure, forgetTunnel, proxyTrust, reclaimAbandonedTunnels, tunnelStatus } = await import('../reachability')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tunnel.status).mockReturnValue(idle)
  vi.mocked(tailscale.status).mockReturnValue(idle)
})

describe('applyExposure', () => {
  const target = { port: 52123, token: 't' }

  it('publishes through the chosen provider and withdraws every other', () => {
    applyExposure('opentunnel', target)
    expect(tunnel.apply).toHaveBeenCalledWith(target)
    expect(tunnel.withdraw).not.toHaveBeenCalled()
    expect(tailscale.withdraw).toHaveBeenCalled()
    expect(tailscale.apply).not.toHaveBeenCalled()
  })

  // Remote access off with a provider still chosen is a stopped server, not a
  // deselection: OpenTunnel keeps its URL for the next start.
  it('tells a chosen provider the server is gone, without withdrawing it', () => {
    applyExposure('opentunnel', null)
    expect(tunnel.apply).toHaveBeenCalledWith(null)
    expect(tunnel.withdraw).not.toHaveBeenCalled()
  })

  it('withdraws every provider when the exposure is off', () => {
    applyExposure('off', target)
    expect(tunnel.withdraw).toHaveBeenCalled()
    expect(tailscale.withdraw).toHaveBeenCalled()
  })
})

describe('proxyTrust', () => {
  it('trusts forwarded headers with nothing chosen, and behind Tailscale Serve', () => {
    expect(proxyTrust('off')).toEqual({ forwardedHeaders: true, httpsHosts: [] })
    expect(proxyTrust('tailscale-serve')).toEqual({ forwardedHeaders: true, httpsHosts: [] })
  })

  it('distrusts them behind OpenTunnel, and names its public host as https', () => {
    expect(proxyTrust('opentunnel')).toEqual({ forwardedHeaders: false, httpsHosts: [] })
    vi.mocked(tunnel.status).mockReturnValue({
      ...idle,
      active: true,
      url: 'https://0123456789abcdef.shmeg77if6cw.opentunnel.xyz/app/?k=x',
    })
    expect(proxyTrust('opentunnel')).toEqual({
      forwardedHeaders: false,
      httpsHosts: ['0123456789abcdef.shmeg77if6cw.opentunnel.xyz'],
    })
  })
})

describe('proxyTrust after switching away from OpenTunnel', () => {
  // The close is queued behind the switch. Until it runs, visitors can still
  // arrive through the tunnel, so their forwarded headers must stay ignored.
  it('stays untrusted while OpenTunnel still holds a connection', () => {
    vi.mocked(tunnel.status).mockReturnValue({
      ...idle,
      active: true,
      port: 52123,
      url: 'https://0123456789abcdef.shmeg77if6cw.opentunnel.xyz/app/?k=x',
    })
    expect(proxyTrust('tailscale-serve')).toEqual({
      forwardedHeaders: false,
      httpsHosts: ['0123456789abcdef.shmeg77if6cw.opentunnel.xyz'],
    })
    expect(proxyTrust('off').forwardedHeaders).toBe(false)
  })

  it('stays untrusted while OpenTunnel is attaching a bridge', () => {
    vi.mocked(tunnel.status).mockReturnValue({ ...idle, busy: true, connection: 'connecting' })
    expect(proxyTrust('tailscale-serve')).toEqual({ forwardedHeaders: false, httpsHosts: [] })
  })

  it('stays untrusted while an OpenTunnel bridge is still closing', () => {
    vi.mocked(tunnel.status).mockReturnValue({ ...idle, busy: true, connection: 'closing' })
    expect(proxyTrust('tailscale-serve').forwardedHeaders).toBe(false)
  })

  // A delete retrying against a dead relay is busy but delivers nobody; it
  // must not keep refusing the phone's Serve socket all the while.
  it('trusts again while OpenTunnel is only deleting', () => {
    vi.mocked(tunnel.status).mockReturnValue({ ...idle, busy: true, progress: 'Deleting the tunnel…' })
    expect(proxyTrust('tailscale-serve')).toEqual({ forwardedHeaders: true, httpsHosts: [] })
  })

  it('trusts again once OpenTunnel holds nothing', () => {
    expect(proxyTrust('tailscale-serve')).toEqual({ forwardedHeaders: true, httpsHosts: [] })
  })
})

describe('tunnelStatus', () => {
  it('carries a withdrawn provider’s failure along with the chosen one', () => {
    vi.mocked(tailscale.status).mockReturnValue({ ...idle, active: true, port: 52123 })
    vi.mocked(tunnel.status).mockReturnValue({ ...idle, error: 'Could not delete the tunnel on the relay' })
    expect(tunnelStatus('tailscale-serve')).toEqual({
      ...idle,
      active: true,
      port: 52123,
      elsewhere: [
        { provider: 'opentunnel', busy: false, progress: null, error: 'Could not delete the tunnel on the relay', forgettable: true },
      ],
    })
  })

  it('carries a withdrawal in progress', () => {
    vi.mocked(tunnel.status).mockReturnValue({ ...idle, busy: true, progress: 'Deleting the tunnel…' })
    expect(tunnelStatus('tailscale-serve').elsewhere).toEqual([
      { provider: 'opentunnel', busy: true, progress: 'Deleting the tunnel…', error: null, forgettable: false },
    ])
  })

  // With nothing chosen, the failure still has to come with its Forget action.
  it('keeps a forgettable failure in elsewhere when the exposure is off', () => {
    vi.mocked(tunnel.status).mockReturnValue({ ...idle, error: 'Could not delete the tunnel on the relay' })
    expect(tunnelStatus('off')).toEqual({
      ...idle,
      elsewhere: [
        { provider: 'opentunnel', busy: false, progress: null, error: 'Could not delete the tunnel on the relay', forgettable: true },
      ],
    })
  })

  it('adds nothing when every other provider is idle', () => {
    expect(tunnelStatus('tailscale-serve')).not.toHaveProperty('elsewhere')
  })
})

describe('forgetTunnel', () => {
  it('forgets a provider that is not chosen', () => {
    forgetTunnel('opentunnel', 'tailscale-serve')
    expect(tunnel.forget).toHaveBeenCalled()
  })

  it('refuses the chosen one', () => {
    expect(() => forgetTunnel('opentunnel', 'opentunnel')).toThrow(/Choose another exposure/)
    expect(tunnel.forget).not.toHaveBeenCalled()
  })
})

describe('reclaimAbandonedTunnels', () => {
  it('tells every provider which exposure is chosen', async () => {
    await reclaimAbandonedTunnels('opentunnel')
    expect(tailscale.reclaimAbandoned).toHaveBeenCalledWith('opentunnel')
    expect(tunnel.reclaimAbandoned).toHaveBeenCalledWith('opentunnel')
  })
})
