import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { userEvent } from 'vitest/browser'
import RemoteAccessPane from '../RemoteAccessPane.svelte'
import type { RemoteAccessConfig, RemoteAccessStatus, RemoteExposure, TunnelStatus, TailscaleStatus } from '../../../../shared/ipc-types'

const TOKEN = '9f3c0a7e5b1d4826aa11cc22dd33ee44ff5566778899aabbccddeeff00112233'
const TAILSCALE_IP = '100.109.247.56'

type Answers = Record<string, unknown>
let answers: Answers
let invoke: ReturnType<typeof vi.fn>

function config(over: Partial<RemoteAccessConfig> = {}): RemoteAccessConfig {
  return { enabled: true, host: '127.0.0.1', port: 0, sttModelPath: '', exposure: 'off', servePort: 0, openTunnelAcknowledged: false, ...over }
}

function status(over: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus {
  return {
    running: true,
    host: '127.0.0.1',
    port: 52123,
    url: `http://127.0.0.1:52123/${TOKEN}/`,
    clients: 0,
    powerSaveBlocked: true,
    error: null,
    ...over,
  }
}

function tailscale(over: Partial<TailscaleStatus> = {}): TailscaleStatus {
  return {
    cli: '/usr/local/bin/tailscale',
    cliUsable: true,
    backendState: 'Running',
    dnsName: 'mac.tail050858.ts.net',
    httpsReady: true,
    hint: null,
    ...over,
  }
}

function serve(over: Partial<TunnelStatus> = {}): TunnelStatus {
  return { active: false, port: null, url: null, busy: false, enableUrl: null, error: null, ...over }
}

beforeEach(() => {
  answers = {
    'remote:config': config(),
    'remote:status': status(),
    'remote:interfaces': [
      { name: 'utun4', address: TAILSCALE_IP, isTailscale: true, isLoopback: false },
      { name: 'lo0', address: '127.0.0.1', isTailscale: false, isLoopback: true },
    ],
    'stt:status': { installed: false, binary: null, modelPath: '', modelReady: false, ready: false, hint: null },
    'tailscale:status': tailscale(),
    'remote:tunnel-status': serve(),
  }
  invoke = vi.fn((channel: string) => {
    const answer = answers[channel]
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(answer)
  })
  vi.stubGlobal('api', { invoke, on: vi.fn(() => () => {}) })
})

afterEach(() => vi.unstubAllGlobals())

const qr = (): HTMLElement | null => screen.queryByTestId('pairing-qr')

/** The pane fetches six channels on mount; nothing it renders is real until they land. */
const loaded = (): Promise<HTMLElement> => screen.findByText('Command line')

describe('section order', () => {
  // The bind and Serve decide what URL the code encodes, so they come before
  // it: set up the route, then scan.
  it('follows the setup flow: route to this Mac, pair, then the rest', async () => {
    render(RemoteAccessPane)
    await loaded()
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim())
    expect(headings).toEqual([
      'How the phone reaches this Mac',
      'Pair a phone',
      'Connection',
      'Notifications',
      'Dictation',
      'Sleep',
    ])
  })
})

describe('pairing a phone', () => {
  it('shows no code for a loopback bind, and says why', async () => {
    render(RemoteAccessPane)
    await waitFor(() => expect(screen.getByText(/Pair a phone/)).toBeInTheDocument())
    expect(qr()).toBeNull()
    expect(screen.getByTestId('pairing-note').textContent).toMatch(/bound to this Mac only/i)
  })

  it('renders nothing at all while remote access is off', async () => {
    answers['remote:config'] = config({ enabled: false })
    answers['remote:status'] = status({ running: false, host: null, port: null, url: null, powerSaveBlocked: false })
    render(RemoteAccessPane)
    await waitFor(() => expect(screen.getByText('Remote access')).toBeInTheDocument())
    // The code encodes a live credential, so an off server must not leave one
    // on screen from a previous state.
    expect(qr()).toBeNull()
    expect(screen.queryByText(/Pair a phone/)).toBeNull()
  })

  it('encodes the HTTPS Serve URL once Serve publishes one', async () => {
    answers['remote:config'] = config({ exposure: 'tailscale-serve' })
    answers['remote:tunnel-status'] = serve({
      active: true,
      port: 52123,
      url: `https://mac.tail050858.ts.net/${TOKEN}/`,
    })
    render(RemoteAccessPane)
    await waitFor(() => expect(qr()).not.toBeNull())
    expect(qr()?.getAttribute('aria-label')).toBe('Pairing code for remote access')
    expect(screen.getByText(/A real HTTPS certificate/)).toBeInTheDocument()
  })

  it('still pairs over the tailnet without Serve, flagged as not a secure context', async () => {
    answers['remote:config'] = config({ host: TAILSCALE_IP })
    answers['remote:status'] = status({ host: TAILSCALE_IP, url: `http://${TAILSCALE_IP}:52123/${TOKEN}/` })
    render(RemoteAccessPane)
    await waitFor(() => expect(qr()).not.toBeNull())
    expect(screen.getByText(/not call it a secure context/)).toBeInTheDocument()
  })
})

describe('Tailscale Serve', () => {
  it('turns the "not enabled" dead end into a link that opens the admin console', async () => {
    const enableUrl = 'https://login.tailscale.com/f/serve?node=nfvSEnrBQr11CNTRL'
    answers['remote:tunnel-status'] = serve({ enableUrl, error: 'Serve is not enabled on your tailnet.' })
    render(RemoteAccessPane)

    const link = await screen.findByRole('button', { name: `${enableUrl} ↗` })
    // The link is an addition to the failure text, never a replacement for it.
    expect(screen.getByText('Serve is not enabled on your tailnet.')).toBeInTheDocument()
    await fireEvent.click(link)
    expect(invoke).toHaveBeenCalledWith('app:open-external', enableUrl)
  })

  it('shows a failure it could not classify instead of hiding it behind a link', async () => {
    answers['remote:tunnel-status'] = serve({
      enableUrl: null,
      error: 'error: HTTPS must be enabled first; visit https://tailscale.com/kb/1153/enabling-https',
    })
    render(RemoteAccessPane)
    await loaded()

    expect(screen.getByText(/HTTPS must be enabled first/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /↗$/ })).toBeNull()
  })

  it('says nothing is published yet when Serve is on but remote access is off', async () => {
    answers['remote:config'] = config({ enabled: false, exposure: 'tailscale-serve' })
    answers['remote:status'] = status({ running: false, host: null, port: null, url: null, powerSaveBlocked: false })
    render(RemoteAccessPane)
    await loaded()

    // Otherwise the switch reads "on" with no text anywhere explaining why
    // nothing happened.
    expect(screen.getByText(/Remote access is off, so nothing is published yet/)).toBeInTheDocument()
  })

  it('is not clickable while a provider request is in flight', async () => {
    answers['remote:tunnel-status'] = serve({ busy: true })
    render(RemoteAccessPane)
    await loaded()

    const choice = screen.getByRole('radio', { name: 'Tailscale Serve' })
    expect(choice).toHaveAttribute('aria-disabled', 'true')
    await fireEvent.click(choice)
    expect(invoke).not.toHaveBeenCalledWith('remote:set-exposure', expect.anything())
    expect(screen.getByRole('radio', { name: 'Off' })).toBeChecked()
  })

  it('reports main’s refusal instead of leaving the toggle silently on', async () => {
    answers['remote:set-exposure'] = new Error('Tailscale Serve proxies to this Mac over loopback')
    render(RemoteAccessPane)
    await loaded()

    const choice = screen.getByRole('radio', { name: 'Tailscale Serve' })
    await fireEvent.click(choice)
    await waitFor(() =>
      expect(screen.getByText(/Serve proxies to this Mac over loopback/)).toBeInTheDocument(),
    )
  })

  it('takes the outcome from remote:tunnel-changed, not from the accepted request', async () => {
    const listeners = new Map<string, (data: unknown) => void>()
    vi.stubGlobal('api', {
      invoke,
      on: vi.fn((channel: string, listener: (data: unknown) => void) => {
        listeners.set(channel, listener)
        return () => {}
      }),
    })
    const url = `https://mac.tail050858.ts.net/app/?k=${TOKEN}`
    let accept: (status: TunnelStatus) => void = () => {}
    invoke.mockImplementation((channel: string) => {
      if (channel === 'remote:set-exposure') return new Promise((resolve) => { accept = resolve })
      if (channel === 'remote:config') return Promise.resolve(config({ exposure: 'tailscale-serve' }))
      return Promise.resolve(answers[channel])
    })
    render(RemoteAccessPane)
    await loaded()

    await fireEvent.click(screen.getByRole('radio', { name: 'Tailscale Serve' }))
    listeners.get('remote:tunnel-changed')?.(serve({ active: true, port: 52123, url }))
    // The acceptance arrives last, still saying busy; it must not win.
    accept(serve({ busy: true }))

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Tailscale Serve' })).toBeEnabled())
    expect(qr()).toBeInTheDocument()
  })

  it('cannot be turned on when no Tailscale CLI was found', async () => {
    answers['tailscale:status'] = tailscale({
      cli: null,
      cliUsable: false,
      backendState: null,
      hint: 'No tailscale command was found.',
    })
    render(RemoteAccessPane)
    await loaded()

    expect(screen.getByRole('radio', { name: 'Tailscale Serve' })).toBeDisabled()
    expect(screen.getByText(/No tailscale command was found\./)).toBeInTheDocument()
  })

  it('cannot be turned on when a command was found but never answered', async () => {
    // The Windows shape: the `$PATH` fallback hands back a bare name it never
    // verified, so a machine with no Tailscale at all still reports a command.
    answers['tailscale:status'] = tailscale({
      cli: 'tailscale',
      cliUsable: false,
      backendState: null,
      dnsName: null,
      httpsReady: false,
      hint: 'tailscale did not answer.',
    })
    render(RemoteAccessPane)
    await loaded()

    expect(screen.getByRole('radio', { name: 'Tailscale Serve' })).toBeDisabled()
  })
})

describe('choosing how to publish', () => {
  it('offers Off, Tailscale Serve and an experimental OpenTunnel, with the stored one checked', async () => {
    answers['remote:config'] = config({ exposure: 'tailscale-serve' })
    render(RemoteAccessPane)
    await loaded()

    const group = screen.getByRole('group', { name: 'Publish beyond this Mac' })
    const choices = Array.from(group.querySelectorAll('input[type="radio"]')).map((el) => el.getAttribute('aria-label'))
    expect(choices).toEqual(['Off', 'Tailscale Serve', 'OpenTunnel'])
    expect(screen.getByRole('radio', { name: 'Tailscale Serve' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'OpenTunnel' })).toHaveAccessibleDescription(/^Experimental\./)
  })

  // Native radios: the browser moves the choice with the arrow keys.
  it('moves the choice with the arrow keys', async () => {
    answers['remote:config'] = config({ exposure: 'tailscale-serve' })
    render(RemoteAccessPane)
    await loaded()
    screen.getByRole('radio', { name: 'Tailscale Serve' }).focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(invoke).toHaveBeenCalledWith('remote:set-exposure', 'off')
  })

  it('keeps focus through a change, so two arrow presses move twice', async () => {
    answers['remote:config'] = config({ openTunnelAcknowledged: true })
    invoke.mockImplementation((channel: string, value?: unknown) => {
      if (channel === 'remote:set-exposure' && typeof value === 'string') {
        answers['remote:config'] = config({ openTunnelAcknowledged: true, exposure: value as RemoteExposure })
      }
      return Promise.resolve(answers[channel])
    })
    render(RemoteAccessPane)
    await loaded()

    screen.getByRole('radio', { name: 'Off' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Tailscale Serve' })).toHaveAttribute('aria-disabled', 'false'))
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Tailscale Serve' }))
    await userEvent.keyboard('{ArrowDown}')

    await waitFor(() => expect(screen.getByRole('radio', { name: 'OpenTunnel' })).toBeChecked())
    const sent = invoke.mock.calls.filter(([channel]) => channel === 'remote:set-exposure').map(([, value]) => value)
    expect(sent).toEqual(['tailscale-serve', 'opentunnel'])
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'OpenTunnel' }))
  })

  it('switches to Off through main', async () => {
    answers['remote:config'] = config({ exposure: 'tailscale-serve' })
    render(RemoteAccessPane)
    await loaded()
    await fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    expect(invoke).toHaveBeenCalledWith('remote:set-exposure', 'off')
  })
})

describe('OpenTunnel', () => {
  const ORIGIN = 'https://0123456789abcdef.shmeg77if6cw.opentunnel.xyz'

  it('asks for the one-time acknowledgement before choosing it, and choosing nothing until then', async () => {
    render(RemoteAccessPane)
    await loaded()

    await fireEvent.click(screen.getByRole('radio', { name: 'OpenTunnel' }))
    const ack = screen.getByTestId('opentunnel-ack')
    expect(ack.textContent).toMatch(/Anyone with the address can reach the sign-in page/)
    expect(ack.textContent).toMatch(/access key is the only\s+protection/)
    expect(ack.textContent).toMatch(/no published terms, pricing or uptime/)
    expect(ack.textContent).toMatch(/deletes the tunnel/)
    expect(ack.textContent).toMatch(/phone has to scan again/)
    expect(invoke).not.toHaveBeenCalledWith('remote:set-exposure', 'opentunnel')

    // The radio the click checked goes back until the choice is confirmed.
    expect(screen.getByRole('radio', { name: 'OpenTunnel' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'Off' })).toBeChecked()

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('opentunnel-ack')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('remote:acknowledge-opentunnel')
  })

  it('records the acknowledgement, then chooses OpenTunnel', async () => {
    answers['remote:acknowledge-opentunnel'] = config({ openTunnelAcknowledged: true })
    render(RemoteAccessPane)
    await loaded()

    await fireEvent.click(screen.getByRole('radio', { name: 'OpenTunnel' }))
    await fireEvent.click(screen.getByRole('button', { name: 'I understand, use OpenTunnel' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote:set-exposure', 'opentunnel'))
    const calls = invoke.mock.calls.map(([channel]) => channel)
    expect(calls.indexOf('remote:acknowledge-opentunnel')).toBeLessThan(calls.indexOf('remote:set-exposure'))
    expect(screen.queryByTestId('opentunnel-ack')).toBeNull()
  })

  it('does not ask again once acknowledged', async () => {
    answers['remote:config'] = config({ openTunnelAcknowledged: true })
    render(RemoteAccessPane)
    await loaded()

    await fireEvent.click(screen.getByRole('radio', { name: 'OpenTunnel' }))
    expect(screen.queryByTestId('opentunnel-ack')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('remote:set-exposure', 'opentunnel')
  })

  it('says provisioning can take a minute while it is in flight', async () => {
    answers['remote:config'] = config({ exposure: 'opentunnel', openTunnelAcknowledged: true })
    answers['remote:tunnel-status'] = serve({ busy: true, progress: 'Waiting for the certificate…' })
    render(RemoteAccessPane)
    await loaded()

    const progress = screen.getByTestId('tunnel-progress')
    expect(progress.textContent).toMatch(/Waiting for the certificate…/)
    expect(progress.textContent).toMatch(/can take a minute/)
    // No code yet, and the note names the provider being waited on.
    expect(qr()).toBeNull()
    expect(screen.getByTestId('pairing-note').textContent).toMatch(/OpenTunnel has not published an address yet/)
  })

  // Provisioning can take minutes; switching away is how it is cancelled.
  it('keeps the choice open while OpenTunnel provisions, and only then', async () => {
    answers['remote:config'] = config({ exposure: 'opentunnel', openTunnelAcknowledged: true })
    answers['remote:tunnel-status'] = serve({ busy: true, progress: 'Waiting for the certificate…' })
    render(RemoteAccessPane)
    await loaded()
    expect(screen.getByRole('radio', { name: 'Off' })).toBeEnabled()
    expect(screen.getByRole('radio', { name: 'Tailscale Serve' })).toBeEnabled()
  })

  it('still reports a tunnel being deleted, or not, after switching to Tailscale', async () => {
    answers['remote:config'] = config({ exposure: 'tailscale-serve', openTunnelAcknowledged: true })
    answers['remote:tunnel-status'] = serve({
      elsewhere: [
        {
          provider: 'opentunnel',
          busy: false,
          progress: null,
          error: 'Could not delete the tunnel on the relay, so it stays on record to try again: the relay answered HTTP 503',
          forgettable: false,
        },
      ],
    })
    render(RemoteAccessPane)
    await loaded()
    expect(screen.getByTestId('tunnel-elsewhere').textContent).toMatch(/^\s*OpenTunnel: Could not delete the tunnel/)
    expect(screen.queryByRole('button', { name: 'Forget without deleting' })).toBeNull()
  })

  it('offers Forget after switching from OpenTunnel to Off with the relay down', async () => {
    answers['remote:config'] = config({ exposure: 'off', openTunnelAcknowledged: true })
    answers['remote:tunnel-status'] = serve({
      elsewhere: [{ provider: 'opentunnel', busy: false, progress: null, error: 'Could not delete the tunnel', forgettable: true }],
    })
    render(RemoteAccessPane)
    await loaded()
    await fireEvent.click(screen.getByRole('button', { name: 'Forget without deleting' }))
    expect(invoke).toHaveBeenCalledWith('remote:forget-tunnel', 'opentunnel')
  })

  it('offers to forget a tunnel the relay will not delete, saying it may remain there', async () => {
    answers['remote:config'] = config({ exposure: 'tailscale-serve', openTunnelAcknowledged: true })
    answers['remote:tunnel-status'] = serve({
      elsewhere: [{ provider: 'opentunnel', busy: false, progress: null, error: 'Could not delete the tunnel', forgettable: true }],
    })
    render(RemoteAccessPane)
    await loaded()

    expect(screen.getByTestId('tunnel-elsewhere').textContent).toMatch(/may then remain\s+on the relay/)
    await fireEvent.click(screen.getByRole('button', { name: 'Forget without deleting' }))
    expect(invoke).toHaveBeenCalledWith('remote:forget-tunnel', 'opentunnel')
  })

  it('shows the public address without the key, the relay state, and pairs on the tunnel URL', async () => {
    answers['remote:config'] = config({ exposure: 'opentunnel', openTunnelAcknowledged: true })
    answers['remote:tunnel-status'] = serve({
      active: true,
      port: 52123,
      url: `${ORIGIN}/app/?k=${TOKEN}`,
      connection: 'reconnecting',
    })
    render(RemoteAccessPane)
    await loaded()

    expect(screen.getByTestId('tunnel-origin').textContent).toBe(ORIGIN)
    expect(screen.getByTestId('tunnel-connection').textContent?.trim()).toBe('Reconnecting…')
    await waitFor(() => expect(qr()).not.toBeNull())
    expect(screen.getByText(/A real HTTPS certificate/)).toBeInTheDocument()
  })

  it('shows the error the tunnel reports', async () => {
    answers['remote:config'] = config({ exposure: 'opentunnel', openTunnelAcknowledged: true })
    answers['remote:tunnel-status'] = serve({ error: 'Lost the connection to the relay: socket hang up' })
    render(RemoteAccessPane)
    await loaded()
    expect(screen.getByText('Lost the connection to the relay: socket hang up')).toBeInTheDocument()
  })

  describe('switching away from a published tunnel', () => {
    beforeEach(() => {
      answers['remote:config'] = config({ exposure: 'opentunnel', openTunnelAcknowledged: true })
      answers['remote:tunnel-status'] = serve({
        active: true,
        port: 52123,
        url: `${ORIGIN}/app/?k=${TOKEN}`,
        connection: 'connected',
        kept: true,
      })
    })

    it('asks first, and switches once confirmed', async () => {
      render(RemoteAccessPane)
      await loaded()
      await fireEvent.click(screen.getByRole('radio', { name: 'Tailscale Serve' }))

      const confirm = screen.getByTestId('opentunnel-leave')
      expect(confirm.textContent).toMatch(/deletes the tunnel/)
      expect(confirm.textContent).toMatch(/phone will need to scan a new code/)
      expect(invoke).not.toHaveBeenCalledWith('remote:set-exposure', expect.anything())

      await fireEvent.click(screen.getByRole('button', { name: 'Delete tunnel and switch' }))
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote:set-exposure', 'tailscale-serve'))
      expect(screen.queryByTestId('opentunnel-leave')).toBeNull()
    })

    it('sends nothing and keeps OpenTunnel selected when cancelled', async () => {
      render(RemoteAccessPane)
      await loaded()
      await fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
      expect(screen.getByRole('radio', { name: 'OpenTunnel' })).toBeChecked()
      expect(screen.getByRole('radio', { name: 'Off' })).not.toBeChecked()

      await fireEvent.click(screen.getByRole('button', { name: 'Keep OpenTunnel' }))
      expect(screen.queryByTestId('opentunnel-leave')).toBeNull()
      expect(screen.getByRole('radio', { name: 'OpenTunnel' })).toBeChecked()
      expect(invoke).not.toHaveBeenCalledWith('remote:set-exposure', expect.anything())
    })

    it('asks before an arrow key moves the choice off OpenTunnel', async () => {
      render(RemoteAccessPane)
      await loaded()
      screen.getByRole('radio', { name: 'OpenTunnel' }).focus()
      await userEvent.keyboard('{ArrowUp}')

      expect(screen.getByTestId('opentunnel-leave').textContent).toMatch(/Switching to Tailscale Serve/)
      expect(screen.getByRole('radio', { name: 'OpenTunnel' })).toBeChecked()
      expect(invoke).not.toHaveBeenCalledWith('remote:set-exposure', expect.anything())
    })

    it('drops the question once the tunnel is gone underneath it', async () => {
      const listeners = new Map<string, (data: unknown) => void>()
      vi.stubGlobal('api', {
        invoke,
        on: vi.fn((channel: string, listener: (data: unknown) => void) => {
          listeners.set(channel, listener)
          return () => {}
        }),
      })
      render(RemoteAccessPane)
      await loaded()
      await fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
      expect(screen.getByTestId('opentunnel-leave')).toBeInTheDocument()

      listeners.get('remote:tunnel-changed')?.(serve({ kept: false }))
      await waitFor(() => expect(screen.queryByTestId('opentunnel-leave')).toBeNull())
    })

    it('lets a first provisioning be cancelled without asking', async () => {
      answers['remote:tunnel-status'] = serve({ busy: true, progress: 'Waiting for the certificate…', kept: false })
      render(RemoteAccessPane)
      await loaded()
      await fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
      expect(screen.queryByTestId('opentunnel-leave')).toBeNull()
      expect(invoke).toHaveBeenCalledWith('remote:set-exposure', 'off')
    })
  })

  it('says the address is kept while remote access is off', async () => {
    answers['remote:config'] = config({ enabled: false, exposure: 'opentunnel', openTunnelAcknowledged: true })
    answers['remote:status'] = status({ running: false, host: null, port: null, url: null, powerSaveBlocked: false })
    render(RemoteAccessPane)
    await loaded()
    expect(screen.getByText(/The address is kept while it is off/)).toBeInTheDocument()
  })
})
