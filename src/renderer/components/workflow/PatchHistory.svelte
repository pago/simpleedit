<script lang="ts">
  import type { Workflow } from '../../../shared/workflow'
  import { patchAge, patchRows } from '../../lib/workflow-patches'

  interface Props {
    workflow: Workflow
    selected: number | null
    onselect: (version: number | null) => void
  }

  let { workflow, selected, onselect }: Props = $props()

  let rows = $derived(patchRows(workflow))
  let now = $state(Date.now())
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000)
    return () => clearInterval(timer)
  })
</script>

<div role="region" aria-label="Patch history" class="max-h-64 overflow-y-auto border-b border-zinc-800 bg-zinc-950/60 px-5 py-2" data-testid="workflow-patches">
  {#if rows.length === 0}
    <p class="text-xs text-zinc-500">The lead hasn't patched this workflow.</p>
  {:else}
    <ul class="flex flex-col gap-1">
      {#each rows as row (row.version)}
        {@const pressed = selected === row.version}
        <!-- The button's ::after covers the row, so its op list clicks too without nesting a list in a button. -->
        <li
          class="relative rounded-md border px-2 py-1.5 text-xs has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sky-400 {pressed
            ? 'border-violet-400/70 bg-violet-950/30'
            : 'border-transparent hover:bg-zinc-800/60'}"
          data-testid="workflow-patch-row"
        >
          <button
            type="button"
            class="w-full text-left outline-none after:absolute after:inset-0 after:content-['']"
            aria-pressed={pressed}
            onclick={() => onselect(pressed ? null : row.version)}
            data-testid="workflow-patch"
            data-version={row.version}
          >
            <span class="font-medium text-zinc-200">Patch {row.number}</span>
            <span class="text-zinc-500"> · v{row.version} · <time datetime={row.at} title={new Date(row.at).toLocaleString()}>{patchAge(row.at, now)}</time></span>
          </button>
          <ul class="mt-0.5 flex flex-col">
            {#each row.ops as op, i (i)}
              <li class="truncate text-zinc-400"><span aria-hidden="true" class="inline-block w-4 text-zinc-500">{op.icon}</span>{op.text}</li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}
</div>
