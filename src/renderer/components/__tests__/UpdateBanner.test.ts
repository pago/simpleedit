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

  it('announces state changes to assistive tech', async () => {
    render(UpdateBanner)
    emit('update:downloaded', { version: '1.2.3' })

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/ready to install/))

    emit('update:error', { message: 'nope', phase: 'install' })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be installed/))
  })
})
