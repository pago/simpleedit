import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import ComposeSheet from '../ComposeSheet.svelte'
import { encodeWav } from '../lib/audio'

/**
 * Leaving a comment sheet — by ✕, the scrim, or the system Back gesture — asks
 * before it loses anything, and a recording in progress is something. When the
 * user does discard, the audio is destroyed: never uploaded, never transcribed.
 */

const SILENCE = new Blob([encodeWav(new Float32Array(1600), 16000)], { type: 'audio/wav' })

/** Fires `dataavailable` AFTER `stop()` returns, exactly as the real one does. */
class FakeMediaRecorder {
  state = 'inactive'
  readonly mimeType = 'audio/wav'
  private handlers = new Map<string, ((event: { data: Blob }) => void)[]>()
  start(): void {
    this.state = 'recording'
  }
  stop(): void {
    this.state = 'inactive'
    queueMicrotask(() => {
      for (const fn of this.handlers.get('dataavailable') ?? []) fn({ data: SILENCE })
      for (const fn of this.handlers.get('stop') ?? []) fn({ data: SILENCE })
    })
  }
  addEventListener(type: string, fn: (event: { data: Blob }) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn])
  }
}

let invoke: ReturnType<typeof vi.fn>
let tracksStopped = 0
let closed = 0

beforeEach(() => {
  tracksStopped = 0
  closed = 0
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'stt:status') {
      return { installed: true, binary: 'whisper-cli', modelPath: '/m.bin', modelReady: true, ready: true, hint: null }
    }
    if (channel === 'stt:transcribe') return 'this should never be heard'
    return undefined
  })
  vi.stubGlobal('api', { invoke, on: () => () => {} })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () =>
        ({ getTracks: () => [{ stop: (): void => { tracksStopped++ } }] }) as unknown as MediaStream,
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mount() {
  return render(ComposeSheet, {
    props: {
      title: 'src/gate.ts:11',
      sendLabel: 'Add',
      placeholder: 'What about this line?',
      onadd: () => {},
      onclose: () => { closed++ },
    },
  })
}

const transcribeCalls = (): unknown[][] => invoke.mock.calls.filter((call) => call[0] === 'stt:transcribe')

describe('ComposeSheet', () => {
  it('lets an empty sheet go', () => {
    const { component } = mount()
    expect(component.holdForDraft()).toBe(false)
  })

  it('holds for a recording with nothing typed, and destroys it on a confirmed discard', async () => {
    const { component } = mount()
    await waitFor(() => expect(screen.getByTestId('mic-start')).not.toBeDisabled())
    await fireEvent.click(screen.getByTestId('mic-start'))
    await waitFor(() => expect(screen.getByTestId('mic-stop')).toBeInTheDocument())

    expect(component.holdForDraft()).toBe(true)
    await waitFor(() => expect(screen.getByTestId('compose-discard-confirm')).toBeInTheDocument())
    expect(closed).toBe(0)

    await fireEvent.click(screen.getByTestId('compose-discard-confirmed'))
    expect(closed).toBe(1)
    // Past the point where the recorder hands its audio over.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(transcribeCalls()).toHaveLength(0)
    expect(tracksStopped).toBe(1)
  })

  it('keeps recording when the user chooses to keep it', async () => {
    const { component } = mount()
    await waitFor(() => expect(screen.getByTestId('mic-start')).not.toBeDisabled())
    await fireEvent.click(screen.getByTestId('mic-start'))
    await waitFor(() => expect(screen.getByTestId('mic-stop')).toBeInTheDocument())

    component.holdForDraft()
    await fireEvent.click(await screen.findByRole('button', { name: 'Keep' }))
    expect(screen.queryByTestId('compose-discard-confirm')).toBeNull()
    expect(screen.getByTestId('mic-stop')).toBeInTheDocument()
    expect(tracksStopped).toBe(0)
  })
})
