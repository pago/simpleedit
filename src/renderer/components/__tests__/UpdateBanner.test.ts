import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import UpdateBanner from '../UpdateBanner.svelte'

type Listener = (data: unknown) => void

let listeners: Map<string, Listener[]>

function emit(channel: string, data: unknown): void {
  for (const fn of listeners.get(channel) ?? []) fn(data)
}

const restartButton = (): ReturnType<typeof screen.getByRole> =>
  screen.getByRole('button', { name: 'Restart & Update' })

beforeEach(() => {
  listeners = new Map()
  vi.stubGlobal('api', {
    on: vi.fn((channel: string, cb: Listener) => {
      const forChannel = listeners.get(channel) ?? []
      forChannel.push(cb)
      listeners.set(channel, forChannel)
      return () => listeners.set(channel, forChannel.filter((fn) => fn !== cb))
    }),
    invoke: vi.fn().mockResolvedValue({ ok: true })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('UpdateBanner', () => {
  it('stays hidden until an update is announced', () => {
    render(UpdateBanner)
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })

  it('shows download progress, then the restart button', async () => {
    render(UpdateBanner)

    emit('update:available', { version: '1.2.3' })
    await waitFor(() => expect(screen.getByText(/Downloading update 1\.2\.3/)).toBeInTheDocument())

    emit('update:downloaded', { version: '1.2.3' })
    await waitFor(() => expect(restartButton()).toBeInTheDocument())
  })

  it('appears on update:downloaded even if update:available was missed', async () => {
    render(UpdateBanner)

    emit('update:downloaded', { version: '1.2.3' })

    await waitFor(() =>
      expect(screen.getByText('Version 1.2.3 is ready to install.')).toBeInTheDocument()
    )
  })

  it('pads the message clear of the macOS traffic lights', async () => {
    const { container } = render(UpdateBanner)

    emit('update:available', { version: '1.2.3' })

    await waitFor(() => {
      const banner = container.querySelector('div')
      expect(banner?.className).toContain('pl-[78px]')
    })
  })

  it('surfaces a failed install instead of looking dead', async () => {
    vi.mocked(window.api.invoke).mockResolvedValue({ ok: false, error: 'Squirrel said no' })
    render(UpdateBanner)
    emit('update:downloaded', { version: '1.2.3' })

    await waitFor(() => restartButton())
    await fireEvent.click(restartButton())

    await waitFor(() => {
      expect(screen.getByText(/could not be installed: Squirrel said no/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Download manually' })).toBeInTheDocument()
    })
  })

  it('reports a rejected install invoke', async () => {
    vi.mocked(window.api.invoke).mockRejectedValue(new Error('no handler registered'))
    render(UpdateBanner)
    emit('update:downloaded', { version: '1.2.3' })

    await waitFor(() => restartButton())
    await fireEvent.click(restartButton())

    await waitFor(() =>
      expect(screen.getByText(/no handler registered/)).toBeInTheDocument()
    )
  })

  // The success path quits the app, so the invoke never settles; the watchdog is
  // the only thing standing between a wedged quit and a dead-looking button.
  it('gives up on a restart that never happens', async () => {
    render(UpdateBanner)
    emit('update:downloaded', { version: '1.2.3' })
    await waitFor(() => restartButton())

    vi.useFakeTimers()
    vi.mocked(window.api.invoke).mockReturnValue(new Promise(() => {}))
    await fireEvent.click(restartButton())
    expect(screen.getByText(/Restarting to install/)).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(screen.getByText(/The restart did not start/)).toBeInTheDocument()
  })

  it('offers a manual download when preparing the update fails', async () => {
    render(UpdateBanner)
    emit('update:downloaded', { version: '1.2.3' })
    await waitFor(() => restartButton())

    emit('update:error', {
      message: 'code signature did not pass validation',
      phase: 'prepare'
    })

    await waitFor(() =>
      expect(
        screen.getByText(/could not be prepared: code signature did not pass validation/)
      ).toBeInTheDocument()
    )

    await fireEvent.click(screen.getByRole('button', { name: 'Download manually' }))
    expect(window.api.invoke).toHaveBeenCalledWith(
      'app:open-external',
      'https://github.com/pago/simpleedit/releases/latest'
    )
  })

  // A failed poll for updates is not a failed install.
  it('ignores check failures', async () => {
    render(UpdateBanner)
    emit('update:downloaded', { version: '1.2.3' })
    await waitFor(() => restartButton())

    emit('update:error', { message: 'net::ERR_INTERNET_DISCONNECTED', phase: 'check' })

    expect(screen.queryByText(/could not be/)).not.toBeInTheDocument()
    expect(restartButton()).toBeInTheDocument()
  })

  it('recovers when the update turns out to be installable after all', async () => {
    render(UpdateBanner)
    emit('update:available', { version: '1.2.3' })
    emit('update:error', { message: 'macOS is still preparing the update.', phase: 'prepare' })
    await waitFor(() => expect(screen.getByText(/could not be prepared/)).toBeInTheDocument())

    emit('update:downloaded', { version: '1.2.3' })

    await waitFor(() => expect(restartButton()).toBeInTheDocument())
    expect(screen.queryByText(/could not be prepared/)).not.toBeInTheDocument()
  })

  describe('on a Homebrew install', () => {
    const COMMAND = 'brew upgrade --cask pago/simpleedit/simpleedit'

    const upgradeButton = (): ReturnType<typeof screen.getByRole> =>
      screen.getByRole('button', { name: 'Update & Restart' })
    const copyButton = (): ReturnType<typeof screen.getByRole> =>
      screen.getByRole('button', { name: 'Copy command' })

    // Spy rather than stub the whole navigator: these run in a real Chromium.
    beforeEach(() => {
      vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    async function announceUpdate(): Promise<void> {
      render(UpdateBanner)
      emit('update:available', { version: '1.2.3', managedByHomebrew: true })
      await waitFor(() => upgradeButton())
    }

    it('offers a real action, not just a command to copy', async () => {
      await announceUpdate()

      expect(screen.getByText(/Version 1\.2\.3 is available via Homebrew/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Restart & Update' })).not.toBeInTheDocument()
    })

    // The invoke never resolves on success — the app is quitting — so the banner
    // has to say what is happening rather than sit there looking idle.
    it('reports that it is quitting to update', async () => {
      vi.mocked(window.api.invoke).mockReturnValue(new Promise(() => {}))
      await announceUpdate()

      await fireEvent.click(upgradeButton())

      await waitFor(() =>
        expect(screen.getByText(/Quitting to update via Homebrew/)).toBeInTheDocument()
      )
      expect(window.api.invoke).toHaveBeenCalledWith('update:install')
    })

    it('surfaces a helper that could not be started', async () => {
      vi.mocked(window.api.invoke).mockResolvedValue({ ok: false, error: 'Could not find brew' })
      await announceUpdate()

      await fireEvent.click(upgradeButton())

      await waitFor(() =>
        expect(screen.getByText(/could not be installed: Could not find brew/)).toBeInTheDocument()
      )
    })

    it('still lets the user run the upgrade themselves', async () => {
      await announceUpdate()

      await fireEvent.click(copyButton())

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(COMMAND)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
      )
    })

    it('survives a rejected clipboard write', async () => {
      vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'))
      await announceUpdate()

      await fireEvent.click(copyButton())

      await waitFor(() => expect(copyButton()).toBeInTheDocument())
      expect(screen.queryByText(/could not be/)).not.toBeInTheDocument()
    })

    // Reported on launch, after the app was closed for the upgrade — so it has to
    // raise the banner on its own, with no update event preceding it.
    it('raises a failed background upgrade by itself, with the log and a fallback', async () => {
      render(UpdateBanner)

      emit('update:homebrew-failed', { version: '1.2.3', message: 'brew exited with status 17' })

      await waitFor(() =>
        expect(screen.getByText(/could not be installed: brew exited with status 17/)).toBeInTheDocument()
      )
      expect(screen.getByText(COMMAND)).toBeInTheDocument()

      await fireEvent.click(screen.getByRole('button', { name: 'Show log' }))
      expect(window.api.invoke).toHaveBeenCalledWith('update:open-log')
    })

    // Nothing else can clear this error: `update:downloaded` never fires for a
    // Homebrew copy (autoDownload is off), so without a retry here the banner is
    // stuck reporting the failure until the app is restarted.
    it('lets the user retry a failed upgrade', async () => {
      vi.mocked(window.api.invoke).mockResolvedValue({ ok: false, error: 'Could not find brew' })
      await announceUpdate()
      await fireEvent.click(upgradeButton())
      await waitFor(() => expect(screen.getByText(/could not be installed/)).toBeInTheDocument())

      vi.mocked(window.api.invoke).mockReturnValue(new Promise(() => {}))
      await fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

      await waitFor(() =>
        expect(screen.getByText(/Quitting to update via Homebrew/)).toBeInTheDocument()
      )
      expect(screen.queryByText(/could not be installed/)).not.toBeInTheDocument()
    })

    // The launch-time report is the case that would otherwise dead-end: it raises
    // the error before the check that finds the update even runs.
    it('can retry an upgrade that failed while the app was closed', async () => {
      render(UpdateBanner)
      emit('update:homebrew-failed', { version: '1.2.3', message: 'brew exited with status 17' })
      await waitFor(() => expect(screen.getByText(/status 17/)).toBeInTheDocument())

      await fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

      expect(window.api.invoke).toHaveBeenCalledWith('update:install')
    })

    // The failure was about 1.2.3; reporting it against 1.2.4 is just wrong, and
    // it would bury the button that installs the version now on offer.
    it('drops a stale failure once a newer version is announced', async () => {
      render(UpdateBanner)
      emit('update:homebrew-failed', { version: '1.2.3', message: 'brew exited with status 17' })
      await waitFor(() => expect(screen.getByText(/status 17/)).toBeInTheDocument())

      emit('update:available', { version: '1.2.4', managedByHomebrew: true })

      await waitFor(() => expect(upgradeButton()).toBeInTheDocument())
      expect(screen.getByText(/Version 1\.2\.4 is available via Homebrew/)).toBeInTheDocument()
      expect(screen.queryByText(/status 17/)).not.toBeInTheDocument()
    })

    // ...but the same version still on offer means the last attempt's failure is
    // exactly the thing the user needs to see.
    it('keeps the failure up when the same version is re-announced', async () => {
      render(UpdateBanner)
      emit('update:homebrew-failed', { version: '1.2.3', message: 'brew exited with status 17' })
      await waitFor(() => expect(screen.getByText(/status 17/)).toBeInTheDocument())

      emit('update:available', { version: '1.2.3', managedByHomebrew: true })

      await waitFor(() => expect(screen.getByRole('button', { name: 'Show log' })).toBeInTheDocument())
      expect(screen.getByText(/status 17/)).toBeInTheDocument()
    })

    // The log button is only meaningful when a helper actually ran and wrote one.
    it('offers no log for an upgrade that never started', async () => {
      vi.mocked(window.api.invoke).mockResolvedValue({ ok: false, error: 'Could not find brew' })
      await announceUpdate()

      await fireEvent.click(upgradeButton())

      await waitFor(() => expect(screen.getByText(/could not be installed/)).toBeInTheDocument())
      expect(screen.queryByRole('button', { name: 'Show log' })).not.toBeInTheDocument()
    })
  })

  it('announces state changes to assistive tech', async () => {
    render(UpdateBanner)
    emit('update:downloaded', { version: '1.2.3' })

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/ready to install/))

    emit('update:error', { message: 'nope', phase: 'install' })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be installed/))
  })
})
