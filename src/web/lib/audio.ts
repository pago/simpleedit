/**
 * What `MediaRecorder` produced → what whisper.cpp reads.
 *
 * The two do not meet on their own. Chrome records WebM/Opus and Safari MP4/AAC;
 * whisper.cpp reads 16 kHz mono 16-bit PCM WAV and nothing else. The usual
 * bridge is ffmpeg, which would be a second thing to install for a feature
 * whose whole point is that it degrades gracefully — so the conversion happens
 * here, where the browser has already had to know how to decode its own output.
 */

/** What whisper.cpp wants, and the only rate this module emits. */
export const TARGET_SAMPLE_RATE = 16000

/** Mix every channel down to one — a spoken reply has nothing in stereo. */
function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0)
  const mixed = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < mixed.length; i++) mixed[i] += data[i]
  }
  for (let i = 0; i < mixed.length; i++) mixed[i] /= buffer.numberOfChannels
  return mixed
}

/**
 * Fallback resampler.
 *
 * `OfflineAudioContext` does this properly, including the low-pass a downsample
 * needs — but Safari has historically refused to construct one below 44.1 kHz,
 * and that is precisely the browser this feature has to reach. Linear
 * interpolation aliases a little; whisper copes, and the alternative is no
 * dictation at all on the target device.
 */
function resampleLinear(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples
  const ratio = from / to
  const out = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)))
  for (let i = 0; i < out.length; i++) {
    const position = i * ratio
    const low = Math.floor(position)
    const high = Math.min(low + 1, samples.length - 1)
    const t = position - low
    out[i] = samples[low] * (1 - t) + samples[high] * t
  }
  return out
}

/** 16-bit PCM WAV around `samples`, which must already be at `sampleRate`. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(bytes)

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: a sample past ±1 would wrap and click.
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }

  return new Uint8Array(bytes)
}

/** Resample with a real filter where the browser allows it, linearly where not. */
async function resample(decoded: AudioBuffer): Promise<Float32Array> {
  if (decoded.sampleRate === TARGET_SAMPLE_RATE) return toMono(decoded)
  try {
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE)),
      TARGET_SAMPLE_RATE,
    )
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    return (await offline.startRendering()).getChannelData(0)
  } catch {
    return resampleLinear(toMono(decoded), decoded.sampleRate, TARGET_SAMPLE_RATE)
  }
}

/**
 * A recorded blob → base64 of a WAV whisper.cpp will read.
 *
 * Base64 because the transport is a JSON WebSocket: a `Uint8Array` does not
 * survive `JSON.stringify`, and inventing a binary frame for one channel would
 * be a second protocol to keep honest.
 */
export async function blobToWavBase64(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer()
  // `webkitAudioContext` is still how older Safari spells it, and this file
  // exists to work on Safari.
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) throw new Error('This browser cannot decode the recording.')

  const context = new Ctor()
  let decoded: AudioBuffer
  try {
    decoded = await context.decodeAudioData(bytes)
  } finally {
    // Closing releases the hardware. An AudioContext left open on a phone is a
    // battery cost for something that ran for one second.
    void context.close().catch(() => { /* already closed */ })
  }

  return toBase64(encodeWav(await resample(decoded), TARGET_SAMPLE_RATE))
}

/**
 * `btoa` over chunks. A whole recording spread over `String.fromCharCode(...)`
 * in one call overflows the argument limit on anything but a very short clip.
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
