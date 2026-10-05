import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
import PairScreen from '../PairScreen.svelte'

const KEY = 'd'.repeat(64)

function link(origin = window.location.origin, key = KEY): string {
  return `${origin}/app/?k=${key}`
}

describe('PairScreen', () => {
  it('says the link is out of date when the key was refused', () => {
    render(PairScreen, { connState: 'stale', legacy: false, onKey: () => {} })
    expect(screen.getByTestId('pair-title')).toHaveTextContent('This link is out of date')
    expect(screen.getByTestId('pair-screen')).toHaveTextContent('Settings → Remote access')
    expect(screen.queryByTestId('pair-legacy')).toBeNull()
  })

  it('asks to pair when there has never been a key', () => {
    render(PairScreen, { connState: 'unpaired', legacy: false, onKey: () => {} })
    expect(screen.getByTestId('pair-title')).toHaveTextContent('Pair with your Mac')
  })

  it('tells an old Home Screen icon what to do once', () => {
    render(PairScreen, { connState: 'unpaired', legacy: true, onKey: () => {} })
    expect(screen.getByTestId('pair-title')).toHaveTextContent('This link is out of date')
    expect(screen.getByTestId('pair-legacy')).toHaveTextContent('Home Screen')
  })

  it('hands a pasted link\'s key over without navigating', async () => {
    const onKey = vi.fn()
    const before = window.location.href
    render(PairScreen, { connState: 'stale', legacy: false, onKey })
    await fireEvent.input(screen.getByTestId('pair-link'), { target: { value: link() } })
    await fireEvent.click(screen.getByTestId('pair-connect'))
    expect(onKey).toHaveBeenCalledWith(KEY)
    expect(window.location.href).toBe(before)
  })

  it('refuses a link for another address and says which', async () => {
    const onKey = vi.fn()
    render(PairScreen, { connState: 'stale', legacy: false, onKey })
    await fireEvent.input(screen.getByTestId('pair-link'), { target: { value: link('http://100.1.2.3:5173') } })
    await fireEvent.click(screen.getByTestId('pair-connect'))
    expect(onKey).not.toHaveBeenCalled()
    expect(screen.getByTestId('pair-problem')).toHaveTextContent('http://100.1.2.3:5173')
  })

  it('says so when the new key is refused too', async () => {
    const view = render(PairScreen, { connState: 'stale', legacy: false, onKey: () => {} })
    await fireEvent.input(screen.getByTestId('pair-link'), { target: { value: link() } })
    await fireEvent.click(screen.getByTestId('pair-connect'))
    await view.rerender({ connState: 'connecting', legacy: false, onKey: () => {} })
    expect(screen.getByTestId('pair-connecting')).toBeInTheDocument()
    await view.rerender({ connState: 'stale', legacy: false, onKey: () => {} })
    expect(screen.getByTestId('pair-problem')).toHaveTextContent('out of date too')
  })

  // Behind a sleeping Mac a submit can stay unanswered indefinitely; the user
  // must still be able to try another code.
  it('stays usable while a submitted key cannot reach the Mac', async () => {
    const onKey = vi.fn()
    const view = render(PairScreen, { connState: 'stale', legacy: false, onKey })
    await fireEvent.input(screen.getByTestId('pair-link'), { target: { value: link() } })
    await fireEvent.click(screen.getByTestId('pair-connect'))
    await view.rerender({ connState: 'closed', legacy: false, onKey })
    expect(screen.getByTestId('pair-connecting')).toHaveTextContent("Can't reach the Mac")
    expect(screen.getByTestId('scan-qr')).not.toBeDisabled()
    await fireEvent.input(screen.getByTestId('pair-link'), { target: { value: link(undefined, 'e'.repeat(64)) } })
    await fireEvent.click(screen.getByTestId('pair-connect'))
    expect(onKey).toHaveBeenLastCalledWith('e'.repeat(64))
  })

  it('releases a camera granted to a scan that was already stopped', async () => {
    const stopped: string[] = []
    let grant: (stream: MediaStream) => void = () => {}
    const fakeStream = (name: string): MediaStream =>
      ({ getTracks: () => [{ stop: () => stopped.push(name) }] }) as unknown as MediaStream
    const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: () => new Promise<MediaStream>((resolve) => { grant = resolve }) },
      configurable: true,
    })
    try {
      render(PairScreen, { connState: 'stale', legacy: false, onKey: () => {}, decoder: async () => async () => null })
      await fireEvent.click(screen.getByTestId('scan-qr'))
      const first = grant
      await fireEvent.click(screen.getByText('Stop camera'))
      first(fakeStream('first'))
      await vi.waitFor(() => expect(stopped).toEqual(['first']))
    } finally {
      if (original) Object.defineProperty(navigator, 'mediaDevices', original)
    }
  })

  it('explains a camera that is not there instead of failing silently', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    try {
      render(PairScreen, { connState: 'stale', legacy: false, onKey: () => {} })
      await fireEvent.click(screen.getByTestId('scan-qr'))
      expect(screen.getByTestId('pair-problem')).toHaveTextContent('Paste the link instead')
    } finally {
      if (original) Object.defineProperty(navigator, 'mediaDevices', original)
    }
  })
})
