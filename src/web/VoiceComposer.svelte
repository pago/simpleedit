<script lang="ts">
  /**
   * Compose a reply: speak it, read it, fix it, send it.
   *
   * Two rules this component exists to enforce.
   *
   * **Review before send is mandatory.** There is no path from audio to the PTY
   * that skips the text box. Dictation reliably mangles branch names, file paths
   * and tool names, and a wrong word sent into a live session is expensive —
   * whereas fixing one word costs far less than typing three sentences on a
   * phone. So a transcript lands in the field, and Send is a separate tap.
   *
   * **Typing always works.** Voice is an accelerant. If whisper.cpp is absent,
   * if the mic is refused, if a transcription fails — the field still takes
   * typed input and the failure costs the dictation and nothing else. The user
   * is never left with no way to reply.
   *
   * ── Lifetime ────────────────────────────────────────────────────────────
   * The recording belongs to this component and to nothing else. It is stopped —
   * and the microphone track with it — on send, on cancel, on unmount, when the
   * page is hidden, and at a hard time cap. A recording that outlived any of
   * those would be a hot mic. The transcription is a plain `invoke`: it belongs
   * to the call, so a socket that drops mid-flight rejects it and the user sees
   * why. The pending transcript is just text, so it survives a reconnect.
   */
  import { onMount } from 'svelte'
  import { blobToWavBase64 } from './lib/audio'
  import type { SttStatus } from '../shared/ipc-types'

  interface Props {
    /** Resolves when the text has reached the PTY. Throwing surfaces here. */
    onsend: (text: string) => Promise<void>
    placeholder?: string
  }

  let { onsend, placeholder = 'Reply…' }: Props = $props()

  /**
   * Hard cap on one recording. Comfortably past a spoken reply, and short
   * enough that a mic left running by accident stops on its own.
   */
  const MAX_RECORDING_MS = 120_000

  let text = $state('')
  let recording = $state(false)
  let elapsedMs = $state(0)
  let transcribing = $state(false)
  let sending = $state(false)
  let error = $state<string | null>(null)
  let stt = $state<SttStatus | null>(null)
  let fieldEl = $state<HTMLTextAreaElement | undefined>()

  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: Blob[] = []
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let tickTimer: ReturnType<typeof setInterval> | undefined

  const micUsable = $derived(
    typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined',
  )
  const canSend = $derived(text.trim().length > 0 && !sending)

  onMount(() => {
    void window.api
      .invoke('stt:status')
      .then((status) => { stt = status })
      .catch(() => { /* the field still works; that is the point */ })

    // A phone that locks, or an app switch, must not leave the mic live.
    const onHidden = (): void => {
      if (document.hidden && recording) stopRecording()
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      teardownRecording()
    }
  })

  /** Release the microphone. Idempotent, and the only place tracks are stopped. */
  function teardownRecording(): void {
    clearTimeout(stopTimer)
    clearInterval(tickTimer)
    stopTimer = undefined
    tickTimer = undefined
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop() } catch { /* already stopping */ }
    }
    recorder = null
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
    recording = false
  }

  async function startRecording(): Promise<void> {
    error = null
    if (!micUsable) {
      error = 'This browser cannot record audio. Type your reply instead.'
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      // Denied, or no secure context. `http://localhost` IS one; a plain-HTTP
      // LAN address is not, which is why the transport is Tailscale.
      const name = err instanceof Error ? err.name : 'Error'
      error =
        name === 'NotAllowedError'
          ? 'Microphone access was refused. Type your reply instead.'
          : `Could not open the microphone (${name}). Type your reply instead.`
      teardownRecording()
      return
    }

    chunks = []
    const media = new MediaRecorder(stream)
    recorder = media
    media.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    })
    media.addEventListener('stop', () => {
      const captured = chunks
      chunks = []
      const type = captured[0]?.type || media.mimeType || 'audio/webm'
      if (captured.length > 0) void transcribe(new Blob(captured, { type }))
    })
    media.start()

    recording = true
    const startedAt = Date.now()
    elapsedMs = 0
    tickTimer = setInterval(() => { elapsedMs = Date.now() - startedAt }, 200)
    stopTimer = setTimeout(stopRecording, MAX_RECORDING_MS)
  }

  /** Stop and transcribe. The `stop` handler above picks the audio up. */
  function stopRecording(): void {
    if (!recording) return
    teardownRecording()
  }

  /** Stop and throw the audio away — the mic was opened by mistake. */
  function cancelRecording(): void {
    chunks = []
    teardownRecording()
  }

  async function transcribe(blob: Blob): Promise<void> {
    transcribing = true
    error = null
    try {
      const audio = await blobToWavBase64(blob)
      const transcript = (await window.api.invoke('stt:transcribe', audio)).trim()
      if (!transcript) {
        error = 'Nothing was recognised in that recording.'
        return
      }
      // Appended, never sent. This is the review step, and it is the only door
      // between the microphone and a live session.
      text = text.trim() ? `${text.trim()} ${transcript}` : transcript
      fieldEl?.focus()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      transcribing = false
    }
  }

  async function send(): Promise<void> {
    const body = text.trim()
    if (!body || sending) return
    sending = true
    error = null
    try {
      await onsend(body)
      text = ''
    } catch (err) {
      // The text stays in the field: a send that failed must not eat the reply.
      error = err instanceof Error ? err.message : String(err)
    } finally {
      sending = false
    }
  }

  const seconds = $derived(Math.floor(elapsedMs / 1000))
</script>

<div class="flex flex-col gap-2" data-testid="voice-composer">
  {#if error}
    <p
      class="rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-xs leading-relaxed text-red-300"
      data-testid="composer-error"
    >{error}</p>
  {/if}

  {#if stt && !stt.ready && micUsable}
    <p class="text-[11px] leading-relaxed text-zinc-500" data-testid="stt-unavailable">
      Dictation is off: {stt.hint} Typing works either way.
    </p>
  {/if}

  <div class="flex items-end gap-2">
    <textarea
      bind:this={fieldEl}
      bind:value={text}
      {placeholder}
      rows="2"
      data-testid="composer-text"
      class="min-h-11 flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm
             text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
    ></textarea>

    {#if recording}
      <button
        type="button"
        onclick={stopRecording}
        data-testid="mic-stop"
        class="min-h-11 flex-none rounded-lg bg-red-600 px-3 text-xs font-semibold text-white active:bg-red-500"
      >Stop {seconds}s</button>
      <button
        type="button"
        onclick={cancelRecording}
        aria-label="Discard recording"
        data-testid="mic-cancel"
        class="min-h-11 flex-none rounded-lg border border-zinc-700 px-3 text-xs text-zinc-400"
      >✕</button>
    {:else}
      <button
        type="button"
        disabled={transcribing || !(stt?.ready ?? true)}
        onclick={() => void startRecording()}
        aria-label="Record a spoken reply"
        data-testid="mic-start"
        class="min-h-11 flex-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-sm text-zinc-200
               active:bg-zinc-700 disabled:opacity-40"
      >{transcribing ? '…' : '🎤'}</button>
    {/if}

    <button
      type="button"
      disabled={!canSend}
      onclick={() => void send()}
      data-testid="composer-send"
      class="min-h-11 flex-none rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white
             active:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600"
    >Send</button>
  </div>

  {#if transcribing}
    <p class="text-[11px] text-zinc-500" data-testid="transcribing">Transcribing…</p>
  {/if}
</div>
