<script lang="ts">
  import { onMount } from 'svelte'
  import Toggle from './Toggle.svelte'

  let leadMayStart = $state<boolean | null>(null)
  let error = $state<string | null>(null)

  onMount(() => {
    window.api
      .invoke('workflow:settings-get')
      .then((s) => {
        leadMayStart = s.leadMayStart
      })
      .catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err)
      })
  })

  async function set(next: boolean): Promise<void> {
    error = null
    try {
      leadMayStart = (await window.api.invoke('workflow:settings-set', { leadMayStart: next })).leadMayStart
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }
</script>

<div class="max-w-2xl space-y-6">
  <header>
    <h1 class="text-lg font-semibold text-zinc-100">Workflows</h1>
    <p class="mt-1 text-[13px] leading-relaxed text-zinc-400">
      A lead session can turn a plan into a workflow: a task graph SimpleEdit runs with hidden worker
      sessions, shown in the lead's Workflow tab.
    </p>
  </header>

  <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
    <div class="flex items-center justify-between gap-4">
      <div class="min-w-0">
        <p class="text-[13.5px] font-medium text-zinc-100">Leads may start workflows</p>
        <p class="mt-0.5 text-xs text-zinc-500">
          Off: a workflow waits as a draft until you review its graph and press Start. On: the lead can
          start it with <code>start_workflow</code> as soon as it is prepared.
        </p>
      </div>
      <Toggle checked={leadMayStart ?? false} disabled={leadMayStart === null} label="Leads may start workflows" onchange={(v) => void set(v)} />
    </div>
    {#if error}<p class="mt-2 text-xs text-red-300" role="alert">{error}</p>{/if}
  </section>
</div>
