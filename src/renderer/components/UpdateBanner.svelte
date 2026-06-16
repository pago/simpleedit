<script lang="ts">
  import { onMount } from 'svelte'

  let updateVersion = $state<string | null>(null)
  let downloaded = $state(false)
  let dismissed = $state(false)

  onMount(() => {
    const offAvailable = window.api.on('update:available', (info) => {
      updateVersion = info.version
    })
    const offDownloaded = window.api.on('update:downloaded', () => {
      downloaded = true
    })
    return () => {
      offAvailable()
      offDownloaded()
    }
  })

  function install() {
    window.api.invoke('update:install')
  }

  function dismiss() {
    dismissed = true
  }
</script>

{#if updateVersion && !dismissed}
  <div class="flex items-center gap-2 border-b border-emerald-800 bg-emerald-950 px-3 py-1.5 text-xs text-emerald-200">
    {#if downloaded}
      <span>Version {updateVersion} is ready to install.</span>
      <button
        class="rounded bg-emerald-700 px-2 py-0.5 text-white hover:bg-emerald-600"
        onclick={install}
      >Restart & Update</button>
    {:else}
      <span>Downloading update {updateVersion}...</span>
    {/if}
    <button
      class="ml-auto text-emerald-400 hover:text-emerald-200"
      onclick={dismiss}
      aria-label="Dismiss"
    >&times;</button>
  </div>
{/if}
