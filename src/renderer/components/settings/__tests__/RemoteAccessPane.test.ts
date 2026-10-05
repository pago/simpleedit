import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import RemoteAccessPane from '../RemoteAccessPane.svelte'
import type { RemoteAccessConfig, RemoteAccessStatus, TailscaleServeStatus, TailscaleStatus } from '../../../../shared/ipc-types'

const TOKEN = '9f3c0a7e5b1d4826aa11cc22dd33ee44ff5566778899aabbccddeeff00112233'
const TAILSCALE_IP = '100.109.247.56'

type Answers = Record<string, unknown>
let answers: Answers
let invoke: ReturnType<typeof vi.fn>

function config(over: Partial<RemoteAccessConfig> = {}): RemoteAccessConfig {
  return { enabled: true, host: '127.0.0.1', port: 0, sttModelPath: '', serveEnabled: false, servePort: 0, ...over }
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

function serve(over: Partial<TailscaleServeStatus> = {}): TailscaleServeStatus {
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
    'tailscale:serve-status': serve(),
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
    answers['remote:config'] = config({ serveEnabled: true })
    answers['tailscale:serve-status'] = serve({
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
    answers['tailscale:serve-status'] = serve({ enableUrl, error: 'Serve is not enabled on your tailnet.' })
    render(RemoteAccessPane)

    const link = await screen.findByRole('button', { name: `${enableUrl} ↗` })
    // The link is an addition to the failure text, never a replacement for it.
    expect(screen.getByText('Serve is not enabled on your tailnet.')).toBeInTheDocument()
    await fireEvent.click(link)
    expect(invoke).toHaveBeenCalledWith('app:open-external', enableUrl)
  })

  it('shows a failure it could not classify instead of hiding it behind a link', async () => {
    answers['tailscale:serve-status'] = serve({
      enableUrl: null,
      error: 'error: HTTPS must be enabled first; visit https://tailscale.com/kb/1153/enabling-https',
    })
    render(RemoteAccessPane)
    await loaded()

    expect(screen.getByText(/HTTPS must be enabled first/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /↗$/ })).toBeNull()
  })

  it('says nothing is published yet when Serve is on but remote access is off', async () => {
    answers['remote:config'] = config({ enabled: false, serveEnabled: true })
    answers['remote:status'] = status({ running: false, host: null, port: null, url: null, powerSaveBlocked: false })
    render(RemoteAccessPane)
    await loaded()

    // Otherwise the switch reads "on" with no text anywhere explaining why
    // nothing happened.
    expect(screen.getByText(/Remote access is off, so nothing is published yet/)).toBeInTheDocument()
  })

  it('is not clickable while a serve command is in flight', async () => {
    answers['tailscale:serve-status'] = serve({ busy: true })
    render(RemoteAccessPane)
    await loaded()

    expect(screen.getByRole('switch', { name: 'Publish over Tailscale Serve' })).toBeDisabled()
  })

  it('reports main’s refusal instead of leaving the toggle silently on', async () => {
    answers['remote:set-serve-enabled'] = new Error('Tailscale Serve proxies to this Mac over loopback')
    render(RemoteAccessPane)
    await loaded()

    const toggle = screen.getByRole('switch', { name: 'Publish over Tailscale Serve' })
    await fireEvent.click(toggle)
    await waitFor(() =>
      expect(screen.getByText(/Serve proxies to this Mac over loopback/)).toBeInTheDocument(),
    )
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

    expect(screen.getByRole('switch', { name: 'Publish over Tailscale Serve' })).toBeDisabled()
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

    expect(screen.getByRole('switch', { name: 'Publish over Tailscale Serve' })).toBeDisabled()
  })
})
