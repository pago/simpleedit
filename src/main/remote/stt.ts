/**
 * Dictation: audio in, text out, entirely on this machine.
 *
 * whisper.cpp is DETECTED, never bundled and never downloaded — the same shape
 * as the agent CLIs (`lib/shell-path.ts`). When it is missing, this module says
 * what to install and the composer falls back to typing. Voice is an
 * accelerant on the mobile surface; it is never the only way to reply.
 *
 * ── Audio is user data ────────────────────────────────────────────────────
 * A recording is a few seconds of somebody's room. It is held in memory and
 * spilled to one 0600 file inside a 0700 temp directory only because
 * whisper.cpp reads from disk; that directory is removed on EVERY path out —
 * success, rejection, timeout, and a whisper that dies on its own. Nothing is
 * written under `userData`, nothing is kept after the call, and neither the
 * audio nor the transcript is ever logged.
 *
 * ── Lifetime ──────────────────────────────────────────────────────────────
 * A transcription belongs to the CALL, not to the client that made it. A socket
 * that drops mid-run loses the answer, which is correct: the recording is gone
 * with it. What must not happen is a child outliving the app — an in-flight
 * discovery blocking quit is a bug this codebase has already shipped once — so
 * every child is tracked and `cancelTranscriptions()` kills the lot before quit.
 */
import { spawn, type ChildProcess } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join } from 'path'
import { resolveExecutable, type KnownExecutable } from '../lib/shell-path'
import { getRemoteConfig, setRemoteConfig } from './config'
import type { SttStatus } from '../../shared/ipc-types'

/** Homebrew's `whisper-cpp` formula installs the first; older builds the second. */
const WHISPER_BINARIES: readonly KnownExecutable[] = ['whisper-cli', 'whisper-cpp']

export const WHISPER_FORMULA = 'whisper-cpp'

/**
 * Cap on one recording, enforced here rather than only in the composer.
 *
 * ~8 MB of 16 kHz mono 16-bit PCM is about 4 minutes, comfortably more than a
 * spoken reply and far less than anything that would matter to hold in memory.
 * A client can send whatever it likes; this is the number that counts.
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024

/**
 * Whisper is roughly realtime on a Mac, so a minute is generous for a reply of
 * a few sentences. Past it the child is killed: a wedged transcription that
 * never answers would leave the composer waiting with a transcript it can
 * neither review nor discard.
 */
const TRANSCRIBE_TIMEOUT_MS = 60_000

const live = new Set<ChildProcess>()

async function resolveWhisper(): Promise<string | null> {
  for (const name of WHISPER_BINARIES) {
    const path = await resolveExecutable(name)
    if (path) return path
  }
  return null
}

function isReadableFile(path: string): boolean {
  if (!path || !isAbsolute(path)) return false
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function hintFor(installed: boolean, modelPath: string, modelReady: boolean): string | null {
  if (!installed) {
    return `whisper.cpp is not installed. \`brew install ${WHISPER_FORMULA}\` adds it, then pick a model file below.`
  }
  if (!modelPath) {
    return 'Pick a whisper.cpp model file (a `ggml-*.bin`). `ggml-base.en.bin` is a good starting point.'
  }
  if (!modelReady) {
    return `No readable file at ${modelPath}. Pick the model again, or check the volume it lives on.`
  }
  return null
}

export async function getSttStatus(): Promise<SttStatus> {
  const binary = await resolveWhisper()
  const modelPath = getRemoteConfig().sttModelPath
  const modelReady = isReadableFile(modelPath)
  const installed = binary !== null
  return {
    installed,
    binary,
    modelPath,
    modelReady,
    ready: installed && modelReady,
    hint: hintFor(installed, modelPath, modelReady),
  }
}

/**
 * Persist a model path, refusing one that is not a readable file.
 *
 * Rejecting here rather than at transcribe time is the difference between the
 * pane saying "that file is not there" while the user is looking at the picker
 * and dictation failing later for no visible reason.
 */
export async function setSttModelPath(path: string): Promise<SttStatus> {
  const trimmed = path.trim()
  if (trimmed && !isReadableFile(trimmed)) {
    throw new Error(`No readable file at ${trimmed}`)
  }
  setRemoteConfig({ ...getRemoteConfig(), sttModelPath: trimmed })
  return await getSttStatus()
}

/** A RIFF/WAVE header, which is the only thing whisper.cpp will read. */
function looksLikeWav(audio: Buffer): boolean {
  return (
    audio.length > 44 &&
    audio.toString('latin1', 0, 4) === 'RIFF' &&
    audio.toString('latin1', 8, 12) === 'WAVE'
  )
}

/**
 * Transcribe one recording. Throws with text a person can act on.
 *
 * Rejects rather than returning an empty string when anything is missing: the
 * composer shows the message and keeps the typed field, so a failure here costs
 * the dictation and nothing else.
 */
export async function transcribe(audioBase64: string): Promise<string> {
  const binary = await resolveWhisper()
  if (!binary) throw new Error(hintFor(false, '', false)!)

  const modelPath = getRemoteConfig().sttModelPath
  if (!isReadableFile(modelPath)) {
    throw new Error(hintFor(true, modelPath, false)!)
  }

  // Base64 inflates by 4/3, so this bounds the decode as well as the result.
  if (audioBase64.length > Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4) {
    throw new Error('That recording is too long to transcribe.')
  }
  const audio = Buffer.from(audioBase64, 'base64')
  if (audio.length > MAX_AUDIO_BYTES) {
    throw new Error('That recording is too long to transcribe.')
  }
  // `Buffer.from(…, 'base64')` ignores anything it cannot decode, so the header
  // check is what actually rejects a client sending something else.
  if (!looksLikeWav(audio)) {
    throw new Error('That audio is not a WAV recording.')
  }

  // `mkdtemp(3)` creates with mode 0700 — the directory is this process's
  // alone before the audio ever lands in it.
  const dir = await mkdtemp(join(tmpdir(), 'simpleedit-stt-'))
  try {
    const wav = join(dir, 'audio.wav')
    await writeFile(wav, audio, { mode: 0o600 })
    return await runWhisper(binary, modelPath, wav)
  } finally {
    // Every path out, including a throw above and a timeout below. The one
    // thing this module must never do is leave somebody's voice on disk.
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* the OS reclaims tmpdir; there is nothing further to try */
    })
  }
}

function runWhisper(binary: string, modelPath: string, wavPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // No shell: every argument is passed as an argument, so a model path with
    // a space, a quote or a `;` in it is a path and nothing else.
    const child = spawn(binary, ['-m', modelPath, '-f', wavPath, '-nt'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    live.add(child)

    let out = ''
    let err = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('Transcription timed out.'))
    }, TRANSCRIBE_TIMEOUT_MS)

    const done = (): void => {
      clearTimeout(timer)
      live.delete(child)
    }

    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    // Whisper writes its model banner and timings here. Kept only to quote back
    // in a failure — never logged, because the transcript can appear in it.
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })

    child.on('error', (error: Error) => {
      done()
      if (settled) return
      settled = true
      reject(new Error(`Could not run ${binary}: ${error.message}`))
    })

    child.on('close', (code) => {
      done()
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(new Error(err.trim().split('\n').slice(-1)[0] || `whisper exited with code ${code}`))
        return
      }
      resolve(out.trim())
    })
  })
}

/**
 * Kill every transcription still running. Called before quit: an in-flight
 * child with a pipe main is still reading holds the process open, and a quit
 * that hangs orphans every agent PTY.
 */
export function cancelTranscriptions(): void {
  for (const child of [...live]) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    live.delete(child)
  }
}
