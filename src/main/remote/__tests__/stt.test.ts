import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
  existsSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// A stand-in for whisper.cpp: a shell script that echoes a fixed transcript,
// so the pipeline is exercised end to end without the real binary.
let fixtures = ''
let fakeWhisper = ''
let resolved: string | null = null

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

vi.mock('../../lib/shell-path', () => ({
  resolveExecutable: () => Promise.resolve(resolved),
}))

let config = { enabled: false, host: '127.0.0.1', port: 0, sttModelPath: '' }
vi.mock('../config', () => ({
  getRemoteConfig: () => config,
  setRemoteConfig: (next: typeof config) => { config = next },
}))

import {
  transcribe,
  getSttStatus,
  setSttModelPath,
  cancelTranscriptions,
  sweepAbandonedAudio,
  MAX_AUDIO_BYTES,
} from '../stt'

/** A minimal but structurally honest 16 kHz mono 16-bit PCM WAV. */
function wav(samples = 160): Buffer {
  const data = Buffer.alloc(samples * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** A pid nothing is using — this process's, far enough away to be free. */
const DEAD_PID = 2_000_000

function sttTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(`simpleedit-stt-${process.pid}-`))
}

beforeEach(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'stt-fixtures-'))
  fakeWhisper = join(fixtures, 'whisper-cli')
  writeFileSync(fakeWhisper, '#!/bin/sh\nprintf "rebase once more before you merge"\n')
  chmodSync(fakeWhisper, 0o755)
  resolved = fakeWhisper
  config = { enabled: false, host: '127.0.0.1', port: 0, sttModelPath: join(fixtures, 'model.bin') }
  writeFileSync(config.sttModelPath, 'not really a model')
  for (const dir of sttTempDirs()) rmSync(join(tmpdir(), dir), { recursive: true, force: true })
})

afterEach(() => {
  rmSync(fixtures, { recursive: true, force: true })
})

describe('stt status', () => {
  it('is ready when both the binary and the model are there', async () => {
    const status = await getSttStatus()
    expect(status).toMatchObject({ installed: true, modelReady: true, ready: true, hint: null })
  })

  it('names the Homebrew formula when whisper is missing', async () => {
    resolved = null
    const status = await getSttStatus()
    expect(status.ready).toBe(false)
    expect(status.hint).toContain('brew install whisper-cpp')
  })

  it('asks for a model when none is configured', async () => {
    config = { ...config, sttModelPath: '' }
    const status = await getSttStatus()
    expect(status.ready).toBe(false)
    expect(status.hint).toContain('model file')
  })

  it('says so when the configured model has gone', async () => {
    config = { ...config, sttModelPath: join(fixtures, 'vanished.bin') }
    const status = await getSttStatus()
    expect(status.modelReady).toBe(false)
    expect(status.hint).toContain('vanished.bin')
  })
})

describe('stt model path', () => {
  it('refuses a path that is not a readable file', async () => {
    await expect(setSttModelPath(join(fixtures, 'nope.bin'))).rejects.toThrow(/No readable file/)
  })

  it('refuses a relative path', async () => {
    await expect(setSttModelPath('models/ggml-base.en.bin')).rejects.toThrow(/No readable file/)
  })

  it('accepts clearing it', async () => {
    const status = await setSttModelPath('')
    expect(status.modelPath).toBe('')
  })
})

describe('transcribe', () => {
  it('returns what whisper printed', async () => {
    const text = await transcribe(wav().toString('base64'))
    expect(text).toBe('rebase once more before you merge')
  })

  it('hands whisper the configured model and a real wav file', async () => {
    const argsFile = join(fixtures, 'args.txt')
    writeFileSync(fakeWhisper, `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\nprintf ok\n`)
    chmodSync(fakeWhisper, 0o755)

    await transcribe(wav().toString('base64'))

    const args = readFileSync(argsFile, 'utf8').trim().split('\n')
    expect(args).toContain('-m')
    expect(args).toContain(config.sttModelPath)
    expect(args).toContain('-nt')
    expect(args.some((a) => a.endsWith('audio.wav'))).toBe(true)
  })

  it('leaves nothing on disk after a success', async () => {
    await transcribe(wav().toString('base64'))
    expect(sttTempDirs()).toEqual([])
  })

  it('leaves nothing on disk after whisper fails', async () => {
    writeFileSync(fakeWhisper, '#!/bin/sh\necho "model load failed" >&2\nexit 1\n')
    chmodSync(fakeWhisper, 0o755)
    await expect(transcribe(wav().toString('base64'))).rejects.toThrow(/model load failed/)
    expect(sttTempDirs()).toEqual([])
  })

  it('never writes the audio when whisper is missing', async () => {
    resolved = null
    await expect(transcribe(wav().toString('base64'))).rejects.toThrow(/brew install/)
    expect(sttTempDirs()).toEqual([])
  })

  it('never writes the audio when the model is missing', async () => {
    config = { ...config, sttModelPath: '' }
    await expect(transcribe(wav().toString('base64'))).rejects.toThrow(/model file/)
    expect(sttTempDirs()).toEqual([])
  })

  it('rejects something that is not a wav, rather than handing it to whisper', async () => {
    await expect(transcribe(Buffer.from('a'.repeat(200)).toString('base64'))).rejects.toThrow(
      /not a WAV/,
    )
    expect(sttTempDirs()).toEqual([])
  })

  it('rejects a recording past the cap without decoding it', async () => {
    const oversized = 'A'.repeat(Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 64)
    await expect(transcribe(oversized)).rejects.toThrow(/too long/)
    expect(sttTempDirs()).toEqual([])
  })
})

describe('audio left on disk', () => {
  it('sweeps what a crash left behind', () => {
    // A pid that is not running: this process's own, plus a large offset.
    const orphan = mkdtempSync(join(tmpdir(), `simpleedit-stt-${DEAD_PID}-`))
    writeFileSync(join(orphan, 'audio.wav'), wav())
    sweepAbandonedAudio()
    expect(existsSync(orphan)).toBe(false)
  })

  // Two instances share one tmpdir. An untagged sweep at launch deletes the WAV
  // another instance's whisper is reading — which is not hypothetical; it broke
  // a passing E2E within minutes of the sweep being written.
  it('leaves a live instance\'s audio alone', () => {
    const theirs = mkdtempSync(join(tmpdir(), `simpleedit-stt-${process.pid}-`))
    writeFileSync(join(theirs, 'audio.wav'), wav())
    // Swept as if by a DIFFERENT process, so this pid reads as somebody else's.
    vi.spyOn(process, 'pid', 'get').mockReturnValue(DEAD_PID)
    try {
      sweepAbandonedAudio()
      expect(existsSync(theirs)).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
    rmSync(theirs, { recursive: true, force: true })
  })

  // Backstop for a recycled pid, where the liveness check would otherwise say
  // "in use" for ever.
  it('sweeps a live pid\'s directory once it is far too old to be in use', () => {
    const stale = mkdtempSync(join(tmpdir(), `simpleedit-stt-${process.pid}-`))
    vi.spyOn(process, 'pid', 'get').mockReturnValue(DEAD_PID)
    try {
      sweepAbandonedAudio(Date.now() + 60 * 60 * 1000)
    } finally {
      vi.restoreAllMocks()
    }
    expect(existsSync(stale)).toBe(false)
  })

  it('ignores anything in tmpdir that is not ours', () => {
    const other = mkdtempSync(join(tmpdir(), 'not-simpleedit-'))
    sweepAbandonedAudio()
    expect(existsSync(other)).toBe(true)
    rmSync(other, { recursive: true, force: true })
  })

  // Quitting skips the `finally` in `transcribe` entirely: the promise that
  // would remove the directory is one nothing left alive will settle.
  it('removes a running transcription\'s audio synchronously on quit', async () => {
    writeFileSync(fakeWhisper, '#!/bin/sh\nsleep 30\n')
    chmodSync(fakeWhisper, 0o755)

    const running = transcribe(wav().toString('base64')).catch(() => 'killed')
    await vi.waitFor(() => expect(sttTempDirs().length).toBe(1))

    cancelTranscriptions()

    expect(sttTempDirs()).toEqual([])
    await running
  })
})

describe('concurrency', () => {
  it('refuses more than the ceiling, without writing their audio', async () => {
    writeFileSync(fakeWhisper, '#!/bin/sh\nsleep 30\n')
    chmodSync(fakeWhisper, 0o755)

    const running = [
      transcribe(wav().toString('base64')).catch(() => 'killed'),
      transcribe(wav().toString('base64')).catch(() => 'killed'),
    ]
    await vi.waitFor(() => expect(sttTempDirs().length).toBe(2))

    // Each of these loads the whole model; the per-request caps bound one
    // request and nothing bounded the fleet.
    await expect(transcribe(wav().toString('base64'))).rejects.toThrow(/Already transcribing/)
    expect(sttTempDirs().length).toBe(2)

    cancelTranscriptions()
    await Promise.all(running)
  })
})
