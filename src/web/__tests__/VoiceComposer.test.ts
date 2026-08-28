import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import VoiceComposer from '../VoiceComposer.svelte'
import { encodeWav } from '../lib/audio'

/**
 * The composer's wiring, not its mechanism.
 *
 * `lib/recorder.test.ts` proves that a discarded recording is never handed
 * over. This proves the buttons reach it: that ✕ takes the discarding path and
 * Stop takes the keeping one, so a rewiring cannot quietly reintroduce the
 * blocker with the mechanism still correct underneath.
 *
 * The audio is a REAL 16 kHz WAV, and both tests use the same one. Feeding the
 * discard case something undecodable would let a failure inside
 * `blobToWavBase64` masquerade as a successful discard — the assertion would
 * pass for entirely the wrong reason.
 */

const SILENCE = new Blob([encodeWav(new Float32Array(1600), 16000)], { type: 'audio/wav' })

/** Fires `dataavailable` AFTER `stop()` returns, exactly as the real one does. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  state = 'inactive'
  readonly mimeType = 'audio/wav'
  private handlers = new Map<string, ((event: { data: Blob }) => void)[]>()

  constructor() {
    FakeMediaRecorder.instances.push(this)
  }

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

let tracksStopped = 0
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  tracksStopped = 0
  FakeMediaRecorder.instances = []

  invoke = vi.fn(async (channel: string) => {
    if (channel === 'stt:status') {
      return { installed: true, binary: 'whisper-cli', modelPath: '/m.bin', modelReady: true, ready: true, hint: null }
    }
    if (channel === 'stt:transcribe') return 'rebase once more before you merge'
    return undefined
  })
  vi.stubGlobal('api', { invoke, on: () => () => {} })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [{ stop: (): void => { tracksStopped++ } }],
      }),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const mic = (): HTMLElement => screen.getByTestId('mic-start')
const transcribeCalls = (): unknown[][] =>
  invoke.mock.calls.filter((call) => call[0] === 'stt:transcribe')

/** Start recording and wait until the recorder is actually live. */
async function startRecording(): Promise<void> {
  await fireEvent.click(mic())
  await waitFor(() => expect(screen.getByTestId('mic-stop')).toBeInTheDocument())
}

describe('VoiceComposer', () => {
  it('transcribes what the user stopped, and puts it in the field to review', async () => {
    render(VoiceComposer, { onsend: async () => {} })
    await startRecording()

    await fireEvent.click(screen.getByTestId('mic-stop'))

    await waitFor(() => expect(transcribeCalls()).toHaveLength(1))
    await waitFor(() =>
      expect(screen.getByTestId('composer-text')).toHaveValue('rebase once more before you merge'),
    )
  })

  // The blocker, at the button. The audio arrives after `stop()` returns, so a
  // discard that only empties a buffer uploads it anyway.
  it('never uploads a recording the user discarded', async () => {
    render(VoiceComposer, { onsend: async () => {} })
    await startRecording()

    await fireEvent.click(screen.getByTestId('mic-cancel'))

    // Well past the microtask that delivers the audio, and past the awaits in
    // the transcribe path that would follow it.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(transcribeCalls()).toHaveLength(0)
    expect(screen.getByTestId('composer-text')).toHaveValue('')
  })

  // Tapping Back unmounts the composer. There is no field left for a transcript
  // to be reviewed in, so uploading there is audio sent for a screen nobody is
  // looking at.
  it('never uploads a recording abandoned by leaving the screen', async () => {
    const view = render(VoiceComposer, { onsend: async () => {} })
    await startRecording()

    view.unmount()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(transcribeCalls()).toHaveLength(0)
  })

  it('releases the microphone whichever way the recording ends', async () => {
    render(VoiceComposer, { onsend: async () => {} })
    await startRecording()
    await fireEvent.click(screen.getByTestId('mic-cancel'))
    await waitFor(() => expect(tracksStopped).toBe(1))
  })

  it('sends what is in the field, not what was transcribed', async () => {
    const sent: string[] = []
    render(VoiceComposer, { onsend: async (text: string) => { sent.push(text) } })

    const field = screen.getByTestId('composer-text')
    await fireEvent.input(field, { target: { value: 'echo reviewed-and-edited' } })
    await fireEvent.click(screen.getByTestId('composer-send'))

    await waitFor(() => expect(sent).toEqual(['echo reviewed-and-edited']))
    await waitFor(() => expect(field).toHaveValue(''))
  })

  it('keeps the reply in the field when sending it fails', async () => {
    render(VoiceComposer, {
      onsend: async () => { throw new Error('Connection lost') },
    })

    const field = screen.getByTestId('composer-text')
    await fireEvent.input(field, { target: { value: 'answer the question' } })
    await fireEvent.click(screen.getByTestId('composer-send'))

    await waitFor(() => expect(screen.getByTestId('composer-error')).toHaveTextContent('Connection lost'))
    expect(field).toHaveValue('answer the question')
  })

  // Voice is an accelerant. A missing model must not leave the user unable to
  // reply — the field still takes typed input and Send still works.
  it('still sends typed text when dictation is unavailable', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'stt:status') {
        return {
          installed: false,
          binary: null,
          modelPath: '',
          modelReady: false,
          ready: false,
          hint: 'whisper.cpp is not installed.',
        }
      }
      return undefined
    })
    const sent: string[] = []
    render(VoiceComposer, { onsend: async (text: string) => { sent.push(text) } })

    await waitFor(() => expect(screen.getByTestId('stt-unavailable')).toBeInTheDocument())
    expect(mic()).toBeDisabled()

    await fireEvent.input(screen.getByTestId('composer-text'), { target: { value: 'carry on' } })
    await fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(sent).toEqual(['carry on']))
  })
})
