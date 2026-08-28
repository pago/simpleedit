/**
 * One recording, and the promise that it is discardable.
 *
 * `MediaRecorder` started without a `timeslice` hands over the WHOLE recording
 * in a single `dataavailable`, and that event fires **after** `stop()` returns,
 * immediately before `stop`. So "clear the buffer, then stop" does not cancel
 * anything — the data has not arrived yet, and it lands in the freshly emptied
 * buffer a tick later. Cancelling has to be a decision recorded BEFORE the
 * data arrives and honoured when it does, which is what `outcome` is.
 *
 * Extracted from the composer so that decision is testable without a
 * microphone: the ordering above is the entire bug, and a component test that
 * stubbed it would be asserting its own stub.
 */

/** What should happen to the audio once the recorder hands it over. */
type Outcome = 'keep' | 'discard'

export interface RecorderHandle {
  /** Stop and deliver the audio to `onAudio`. */
  finish: () => void
  /** Stop and destroy the audio. `onAudio` is never called. */
  discard: () => void
  readonly active: boolean
}

export interface RecorderOptions {
  /** Called once, with the whole recording, only after a `finish`. */
  onAudio: (audio: Blob) => void
  /** Stopped for a reason the caller did not ask for — the time cap. */
  onAutoStop?: () => void
  /** Hard cap, so a microphone left open by accident closes itself. */
  maxMs?: number
}

/**
 * The `MediaRecorder` surface used here, named so a test can supply its own.
 * Structurally satisfied by the real thing.
 */
export interface RecorderLike {
  start(): void
  stop(): void
  readonly state: string
  readonly mimeType: string
  addEventListener(type: 'dataavailable', fn: (event: { data: Blob }) => void): void
  addEventListener(type: 'stop', fn: () => void): void
}

/** The `MediaStream` surface used here — just the tracks, so they can be closed. */
export interface StreamLike {
  getTracks(): { stop(): void }[]
}

export const DEFAULT_MAX_RECORDING_MS = 120_000

/**
 * Drive a recorder that is already started-able, owning its stop paths.
 *
 * Every exit — finish, discard, the time cap, and the caller going away —
 * stops the recorder AND every track on the stream. A track left running is a
 * live microphone with nothing on screen to say so.
 */
export function driveRecorder(
  recorder: RecorderLike,
  stream: StreamLike,
  options: RecorderOptions,
): RecorderHandle {
  // The whole fix. Set before `stop()` is called, read when the data arrives.
  let outcome: Outcome = 'keep'
  let stopped = false
  let chunks: Blob[] = []

  const cap = setTimeout(() => {
    if (stopped) return
    stop('keep')
    options.onAutoStop?.()
  }, options.maxMs ?? DEFAULT_MAX_RECORDING_MS)

  recorder.addEventListener('dataavailable', (event: { data: Blob }) => {
    // Dropped on arrival rather than cleared beforehand: this is the callback
    // that runs after `stop()`, so it is the first moment the audio exists.
    if (outcome === 'discard') return
    if (event.data.size > 0) chunks.push(event.data)
  })

  recorder.addEventListener('stop', () => {
    const captured = chunks
    chunks = []
    if (outcome === 'discard' || captured.length === 0) return
    options.onAudio(new Blob(captured, { type: captured[0].type || recorder.mimeType }))
  })

  function releaseMicrophone(): void {
    clearTimeout(cap)
    for (const track of stream.getTracks()) track.stop()
  }

  function stop(next: Outcome): void {
    if (stopped) return
    stopped = true
    outcome = next
    if (next === 'discard') chunks = []
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        /* already stopping; the handlers above still run */
      }
    }
    releaseMicrophone()
  }

  recorder.start()

  return {
    finish: () => stop('keep'),
    discard: () => stop('discard'),
    get active(): boolean {
      return !stopped
    },
  }
}
