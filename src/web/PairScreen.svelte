<script lang="ts">
  /**
   * The way back in when the app has no current key: scan the Mac's QR code
   * here, inside the app, or paste its link.
   *
   * It has to be in the app. The iPhone Camera opens a scanned link in Safari,
   * whose storage is separate from the Home Screen app's, so the app would
   * never learn the key; and navigating to a new URL would leave the app's
   * scope for an in-app browser. So the key is read here and handed to the
   * socket, and nothing navigates.
   *
   * The camera stays on this one screen. iOS stops a stream on navigation, and
   * asks for camera permission again on most launches of a standalone app —
   * acceptable for something done once per Mac restart.
   */
  import { createDecoder, type FrameDecoder } from './lib/qr-scan'
  import { pairingProblem, parsePairingLink } from './lib/remote-key'
  import type { ConnectionState } from './api-shim'

  interface Props {
    connState: ConnectionState
    /** Arrived through a pre-#190 `/<key>/` link — possibly an old Home Screen icon. */
    legacy: boolean
    onKey: (key: string) => void
    /** Injected by tests; the camera path uses `createDecoder`. */
    decoder?: () => Promise<FrameDecoder>
  }

  let { connState, legacy, onKey, decoder = createDecoder }: Props = $props()

  let scanning = $state(false)
  let problem = $state<string | null>(null)
  let pasted = $state('')
  /** A key has been handed over, so a return to `stale` means THAT one is out of date too. */
  let submitted = $state(false)

  let video = $state<HTMLVideoElement | undefined>()
  let stream: MediaStream | null = null
  /** Bumped by every start and stop, so a camera granted to a superseded start is released. */
  let cameraRun = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const title = $derived(connState === 'unpaired' && !legacy ? 'Pair with your Mac' : 'This link is out of date')
  const connecting = $derived(submitted && connState === 'connecting')
  const unreachable = $derived(submitted && connState === 'closed')

  /**
   * The new key's attempt has begun. Until it has, `stale` is still the verdict
   * on the OLD key — the prop catches up a tick after `onKey`.
   */
  let attempting = false
  $effect(() => {
    if (!submitted) return
    if (connState !== 'stale') attempting = true
    else if (attempting) {
      attempting = false
      submitted = false
      problem = 'That code is out of date too. Scan the one showing on the Mac now.'
    }
  })

  $effect(() => () => stopCamera())

  function accept(text: string): boolean {
    const link = parsePairingLink(text, window.location.origin)
    if (!link.ok) {
      problem = pairingProblem(link)
      return false
    }
    problem = null
    submitted = true
    stopCamera()
    onKey(link.key)
    return true
  }

  function stopCamera(): void {
    cameraRun++
    scanning = false
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
  }

  async function startCamera(): Promise<void> {
    if (scanning) return
    problem = null
    if (!navigator.mediaDevices?.getUserMedia) {
      problem = 'The camera is not available on this address. Paste the link instead.'
      return
    }
    scanning = true
    const run = ++cameraRun
    let granted: MediaStream
    try {
      granted = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      })
    } catch {
      if (run === cameraRun) {
        scanning = false
        problem = 'The camera was not allowed. Allow it when asked, or paste the link instead.'
      }
      return
    }
    if (run !== cameraRun || !video) {
      for (const track of granted.getTracks()) track.stop()
      return
    }
    stream = granted
    video.srcObject = stream
    await video.play().catch(() => undefined)
    const decode = await decoder()
    const canvas = document.createElement('canvas')
    const tick = async (): Promise<void> => {
      if (run !== cameraRun || !video) return
      if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        // Downscaled: a QR on a laptop screen reads fine at this size, and a
        // full-resolution frame every tick heats the phone for nothing.
        const scale = Math.min(1, 640 / video.videoWidth)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        canvas.getContext('2d', { willReadFrequently: true })?.drawImage(video, 0, 0, canvas.width, canvas.height)
        const text = await decode(canvas).catch(() => null)
        if (text && accept(text)) return
      }
      if (run === cameraRun) timer = setTimeout(() => void tick(), 150)
    }
    void tick()
  }

  function submitPasted(event: SubmitEvent): void {
    event.preventDefault()
    if (accept(pasted)) pasted = ''
  }
</script>

<div class="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-zinc-950 px-4 pb-8 pt-[max(1.5rem,env(safe-area-inset-top))]" data-testid="pair-screen" data-state={connState}>
  <h1 class="text-lg font-semibold text-zinc-100" data-testid="pair-title">{title}</h1>
  <p class="mt-2 text-[13px] leading-relaxed text-zinc-400">
    {#if connState === 'unpaired' && !legacy}
      Scan the QR code in Settings → Remote access on the Mac.
    {:else}
      SimpleEdit has restarted, so the key this app had no longer works. Scan the QR code in
      Settings → Remote access.
    {/if}
  </p>
  {#if legacy}
    <p class="mt-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-2.5 py-2 text-xs leading-relaxed text-amber-300" data-testid="pair-legacy">
      This link was made by an older SimpleEdit. If you opened it from a Home Screen icon, remove
      that icon, open the new QR code's link in Safari and add it to the Home Screen again. After
      that, a restart only needs a rescan here.
    </p>
  {/if}

  <div class="mt-4 overflow-hidden rounded-lg border border-zinc-800 bg-black {scanning ? '' : 'hidden'}">
    <!-- `playsinline` and `muted`: without them iOS takes the video fullscreen. -->
    <video bind:this={video} class="aspect-square w-full object-cover" playsinline muted autoplay data-testid="pair-video"></video>
  </div>

  <div class="mt-4 flex gap-2">
    {#if scanning}
      <button
        type="button"
        onclick={stopCamera}
        class="min-h-10 flex-1 rounded-md bg-zinc-800 px-3 text-sm text-zinc-200 active:bg-zinc-700"
      >Stop camera</button>
    {:else}
      <button
        type="button"
        onclick={() => void startCamera()}
        data-testid="scan-qr"
        class="min-h-10 flex-1 rounded-md bg-zinc-100 px-3 text-sm font-semibold text-zinc-900 disabled:opacity-40"
      >Scan QR code</button>
    {/if}
  </div>

  <form class="mt-4" onsubmit={submitPasted}>
    <label class="text-xs text-zinc-500" for="pair-link">Or paste the link</label>
    <div class="mt-1 flex gap-2">
      <input
        id="pair-link"
        type="url"
        bind:value={pasted}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="https://…/app/?k=…"
        data-testid="pair-link"
        class="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-base text-zinc-100 placeholder:text-zinc-600"
      />
      <button
        type="submit"
        disabled={pasted.trim() === ''}
        data-testid="pair-connect"
        class="min-h-10 flex-none rounded-md bg-zinc-800 px-3 text-sm text-zinc-200 active:bg-zinc-700 disabled:opacity-40"
      >Connect</button>
    </div>
  </form>

  {#if connecting}
    <p class="mt-3 text-xs text-zinc-400" data-testid="pair-connecting">Connecting…</p>
  {:else if unreachable}
    <p class="mt-3 text-xs text-zinc-400" data-testid="pair-connecting">
      Can't reach the Mac right now — still trying. Check it is awake and remote access is on.
    </p>
  {/if}
  {#if problem}
    <p class="mt-3 rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-2 text-xs leading-relaxed text-red-300" data-testid="pair-problem">
      {problem}
    </p>
  {/if}
</div>
