import { describe, it, expect, vi } from 'vitest'
import { driveRecorder, type RecorderLike, type StreamLike } from '../recorder'

/**
 * A `MediaRecorder` that reproduces the ordering the real one guarantees, and
 * that the first version of this code got wrong: started without a
 * `timeslice`, it delivers the WHOLE recording in one `dataavailable` **after**
 * `stop()` returns, and only then fires `stop`.
 *
 * A fake that handed the data over before `stop()` would make every test here
 * pass against the broken implementation, which is the point of spelling the
 * order out.
 */
class FakeRecorder implements RecorderLike {
  state = 'inactive'
  readonly mimeType = 'audio/webm'
  private onData: ((event: { data: Blob }) => void)[] = []
  private onStop: (() => void)[] = []
  private onError: (() => void)[] = []

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    // Deliberately after `stop()` has returned to its caller.
    queueMicrotask(() => {
      for (const fn of this.onData) fn({ data: new Blob(['x'.repeat(3306)], { type: 'audio/webm' }) })
      for (const fn of this.onStop) fn()
    })
  }

  /** Drive the recorder's own `error` event, which destroys the recording. */
  fail(): void {
    this.state = 'inactive'
    for (const fn of this.onError) fn()
  }

  addEventListener(type: 'dataavailable', fn: (event: { data: Blob }) => void): void
  addEventListener(type: 'stop', fn: () => void): void
  addEventListener(type: 'error', fn: (event: unknown) => void): void
  addEventListener(type: string, fn: unknown): void {
    if (type === 'dataavailable') this.onData.push(fn as (event: { data: Blob }) => void)
    else if (type === 'error') this.onError.push(fn as () => void)
    else this.onStop.push(fn as () => void)
  }
}

function fakeStream(): StreamLike & { stopped: number } {
  const tracks = [{ stop: (): void => { state.stopped++ } }, { stop: (): void => { state.stopped++ } }]
  const state = { getTracks: () => tracks, stopped: 0 }
  return state
}

/** Let the microtask the fake queues actually run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('driveRecorder', () => {
  it('delivers the audio after finish', async () => {
    const onAudio = vi.fn()
    driveRecorder(new FakeRecorder(), fakeStream(), { onAudio }).finish()
    await settle()
    expect(onAudio).toHaveBeenCalledTimes(1)
    expect((onAudio.mock.calls[0][0] as Blob).size).toBe(3306)
  })

  // The blocker. Discarding cannot work by emptying a buffer, because the
  // audio has not been handed over yet when `discard()` runs.
  it('never delivers audio that was discarded, even though it arrives later', async () => {
    const onAudio = vi.fn()
    driveRecorder(new FakeRecorder(), fakeStream(), { onAudio }).discard()
    await settle()
    expect(onAudio).not.toHaveBeenCalled()
  })

  it('releases every microphone track on finish', async () => {
    const stream = fakeStream()
    driveRecorder(new FakeRecorder(), stream, { onAudio: vi.fn() }).finish()
    await settle()
    expect(stream.stopped).toBe(2)
  })

  it('releases every microphone track on discard', async () => {
    const stream = fakeStream()
    driveRecorder(new FakeRecorder(), stream, { onAudio: vi.fn() }).discard()
    await settle()
    expect(stream.stopped).toBe(2)
  })

  it('ignores a second stop, whichever kind it is', async () => {
    const onAudio = vi.fn()
    const handle = driveRecorder(new FakeRecorder(), fakeStream(), { onAudio })
    handle.finish()
    handle.discard()
    await settle()
    // The first decision stands: discarding after finishing must not lose the
    // audio the user asked to keep, and finishing after discarding must not
    // resurrect audio they threw away.
    expect(onAudio).toHaveBeenCalledTimes(1)
  })

  it('reports itself inactive once stopped', () => {
    const handle = driveRecorder(new FakeRecorder(), fakeStream(), { onAudio: vi.fn() })
    expect(handle.active).toBe(true)
    handle.discard()
    expect(handle.active).toBe(false)
  })

  it('stops itself at the cap and says so', async () => {
    const onAudio = vi.fn()
    const onAutoStop = vi.fn()
    driveRecorder(new FakeRecorder(), fakeStream(), { onAudio, onAutoStop, maxMs: 5 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(onAutoStop).toHaveBeenCalledTimes(1)
    // A capped recording is kept, not thrown away — the user was talking.
    expect(onAudio).toHaveBeenCalledTimes(1)
  })

  it('does not fire the cap after an ordinary stop', async () => {
    const onAutoStop = vi.fn()
    driveRecorder(new FakeRecorder(), fakeStream(), { onAudio: vi.fn(), onAutoStop, maxMs: 5 }).finish()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(onAutoStop).not.toHaveBeenCalled()
  })
})

describe('driveRecorder failures', () => {
  it('reports a stop that throws, rather than going quiet', async () => {
    class ThrowingRecorder extends FakeRecorder {
      override stop(): void {
        throw new Error('InvalidStateError')
      }
    }
    const onError = vi.fn()
    const onAudio = vi.fn()
    driveRecorder(new ThrowingRecorder(), fakeStream(), { onAudio, onError }).finish()
    await settle()
    // Neither a transcript nor silence: the caller is told its audio is gone.
    expect(onAudio).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('says nothing when a discard cannot stop cleanly', async () => {
    class ThrowingRecorder extends FakeRecorder {
      override stop(): void {
        throw new Error('InvalidStateError')
      }
    }
    const onError = vi.fn()
    driveRecorder(new ThrowingRecorder(), fakeStream(), { onAudio: vi.fn(), onError }).discard()
    await settle()
    // The user threw the audio away; its failure to stop is not news.
    expect(onError).not.toHaveBeenCalled()
  })

  it('destroys the audio when the recorder itself errors', async () => {
    const recorder = new FakeRecorder()
    const onAudio = vi.fn()
    const onError = vi.fn()
    driveRecorder(recorder, fakeStream(), { onAudio, onError })
    recorder.fail()
    await settle()
    expect(onAudio).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
