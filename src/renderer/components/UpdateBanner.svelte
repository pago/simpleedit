<script lang="ts">
  import { onMount } from 'svelte'
  import { BREW_UPGRADE_COMMAND } from '../../shared/ipc-types'

  const RELEASES_URL = 'https://github.com/pago/simpleedit/releases/latest'

  // A successful install quits the app, so the invoke never resolves. If we're
  // still alive after this long, the restart didn't take.
  const INSTALL_TIMEOUT_MS = 10_000
  const COPIED_FEEDBACK_MS = 2_000

  let updateVersion = $state<string | null>(null)
  let downloaded = $state(false)
  let installing = $state(false)
  let error = $state<string | null>(null)
  let errorPhase = $state<'prepare' | 'install'>('install')
  let dismissed = $state(false)
  let homebrew = $state(false)
  let copied = $state(false)
  let hasLog = $state(false)

  let installTimer: ReturnType<typeof setTimeout> | undefined
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  function fail(message: string, phase: 'prepare' | 'install'): void {
    clearTimeout(installTimer)
    installing = false
    error = message
    errorPhase = phase
  }

  // A Homebrew update quits the app on the way out, so a successful invoke never
  // resolves — same shape as the Squirrel path, same watchdog.
  async function brewUpgrade() {
    error = null
    installing = true
    installTimer = setTimeout(
      () => fail('The update did not start.', 'install'),
      INSTALL_TIMEOUT_MS
    )
    try {
      const result = await window.api.invoke('update:install')
      if (!result.ok) fail(result.error ?? 'The update could not be started.', 'install')
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err), 'install')
    }
  }

  function openLog() {
    window.api.invoke('update:open-log')
  }

  onMount(() => {
    const offAvailable = window.api.on('update:available', (info) => {
      // A failure belongs to the version it was reported for. Once a different
      // one is announced the old message would be rendered against the new
      // version — and on the Homebrew path it would also keep the error branch
      // up, hiding the button that offers the new update.
      if (info.version !== updateVersion) {
        clearTimeout(installTimer)
        error = null
        hasLog = false
      }
      updateVersion = info.version
      homebrew = info.managedByHomebrew === true
    })
    const offDownloaded = window.api.on('update:downloaded', (info) => {
      updateVersion = info.version
      homebrew = info.managedByHomebrew === true
      downloaded = true
      // A stage that lands after a reported failure (or after our staging
      // timeout gave up on it) makes the update installable again.
      clearTimeout(installTimer)
      error = null
    })
    const offError = window.api.on('update:error', (info) => {
      if (info.phase === 'check') return
      fail(info.message, info.phase)
    })
    // Reported on launch, so it has to raise the banner by itself rather than
    // decorate one an update event already put up.
    const offBrewFailed = window.api.on('update:homebrew-failed', (info) => {
      updateVersion = info.version || updateVersion
      homebrew = true
      hasLog = true
      fail(info.message, 'install')
    })
    return () => {
      offAvailable()
      offDownloaded()
      offError()
      offBrewFailed()
      clearTimeout(installTimer)
      clearTimeout(copiedTimer)
    }
  })

  async function copyUpgradeCommand() {
    try {
      await navigator.clipboard.writeText(BREW_UPGRADE_COMMAND)
      copied = true
      clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => (copied = false), COPIED_FEEDBACK_MS)
    } catch {
      // The command is spelled out in the banner, so a denied clipboard just
      // means the user selects it by hand — nothing worth an error state.
    }
  }

  async function install() {
    error = null
    installing = true
    installTimer = setTimeout(
      () => fail('The restart did not start.', 'install'),
      INSTALL_TIMEOUT_MS
    )
    try {
      const result = await window.api.invoke('update:install')
      if (!result.ok) fail(result.error ?? 'The update could not be installed.', 'install')
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err), 'install')
    }
  }

  function openReleases() {
    window.api.invoke('app:open-external', RELEASES_URL)
  }

  function dismiss() {
    dismissed = true
  }
</script>

{#if updateVersion && !dismissed}
  <!-- pl-[78px] clears the macOS traffic lights, which float over this banner
       because it renders above the title bar. -->
  <div
    class="flex min-h-9 flex-none items-center gap-2 border-b py-1.5 pr-3 pl-[78px] text-xs {error
      ? 'border-rose-800 bg-rose-950 text-rose-200'
      : 'border-emerald-800 bg-emerald-950 text-emerald-200'}"
  >
    {#if homebrew && error}
      <span role="alert">Update {updateVersion} could not be installed: {error}</span>
      <!-- Without this the Homebrew path has no way out of the error state: the
           "Update & Restart" button lives in the branch below, and the event that
           clears the error elsewhere (`update:downloaded`) never fires for a
           Homebrew copy, because `autoDownload` is off for it. -->
      <button
        class="rounded bg-rose-700 px-2 py-0.5 text-white hover:bg-rose-600"
        onclick={brewUpgrade}
      >Try again</button>
      {#if hasLog}
        <button
          class="rounded bg-rose-700 px-2 py-0.5 text-white hover:bg-rose-600"
          onclick={openLog}
        >Show log</button>
      {/if}
      <!-- The command is the fallback when the helper could not do it for them. -->
      <code class="rounded bg-rose-900 px-1 py-0.5">{BREW_UPGRADE_COMMAND}</code>
      <button
        class="rounded border border-rose-700 px-2 py-0.5 text-rose-100 hover:bg-rose-900"
        onclick={copyUpgradeCommand}
      >{copied ? 'Copied' : 'Copy'}</button>
    {:else if homebrew}
      <span role="status" aria-live="polite">
        {#if installing}
          Quitting to update via Homebrew...
        {:else}
          Version {updateVersion} is available via Homebrew.
        {/if}
      </span>
      {#if !installing}
        <button
          class="rounded bg-emerald-700 px-2 py-0.5 text-white hover:bg-emerald-600"
          onclick={brewUpgrade}
        >Update &amp; Restart</button>
        <!-- Kept as an escape hatch: some users would rather run it themselves,
             and it must be run outside SimpleEdit's own terminal. -->
        <button
          class="rounded border border-emerald-700 px-2 py-0.5 text-emerald-100 hover:bg-emerald-900"
          onclick={copyUpgradeCommand}
          title={BREW_UPGRADE_COMMAND}
        >{copied ? 'Copied' : 'Copy command'}</button>
      {/if}
    {:else if error}
      <span role="alert"
        >Update {updateVersion} could not be {errorPhase === 'prepare'
          ? 'prepared'
          : 'installed'}: {error}</span
      >
      <button
        class="rounded bg-rose-700 px-2 py-0.5 text-white hover:bg-rose-600"
        onclick={openReleases}
      >Download manually</button>
      {#if downloaded}
        <button
          class="rounded border border-rose-700 px-2 py-0.5 text-rose-100 hover:bg-rose-900"
          onclick={install}
        >Retry restart</button>
      {/if}
    {:else}
      <span role="status" aria-live="polite">
        {#if installing}
          Restarting to install {updateVersion}...
        {:else if downloaded}
          Version {updateVersion} is ready to install.
        {:else}
          Downloading update {updateVersion}...
        {/if}
      </span>
      {#if downloaded && !installing}
        <button
          class="rounded bg-emerald-700 px-2 py-0.5 text-white hover:bg-emerald-600"
          onclick={install}
        >Restart &amp; Update</button>
      {/if}
    {/if}
    <button
      class="ml-auto opacity-70 hover:opacity-100"
      onclick={dismiss}
      aria-label="Dismiss"
    >&times;</button>
  </div>
{/if}
