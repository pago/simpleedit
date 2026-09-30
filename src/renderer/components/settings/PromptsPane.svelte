<script lang="ts">
  import { onMount } from 'svelte'
  import PromptEditor from './PromptEditor.svelte'
  import MonacoDiffEditor from '../editor/MonacoDiffEditor.svelte'
  import type { PromptGroup, PromptId, PromptInfo, PromptStatus } from '../../../shared/ipc-types'

  interface Editing {
    id: PromptId
    /** What is on disk — `dirty` compares against it. */
    saved: string
    text: string
    defaultText: string
    mode: 'edit' | 'compare'
  }

  const GROUPS: { id: PromptGroup; label: string }[] = [
    { id: 'screening', label: 'Screening' },
    { id: 'deep-review', label: 'Deep review' },
  ]

  const MODES: { mode: Editing['mode']; label: string }[] = [
    { mode: 'edit', label: 'Edit' },
    { mode: 'compare', label: 'Compare with default' },
  ]

  const STATUS_LABEL: Record<PromptStatus, string> = {
    default: 'Default',
    custom: 'Custom',
    outdated: 'Outdated',
    error: 'Error',
  }

  const STATUS_CLASS: Record<PromptStatus, string> = {
    default: 'border-zinc-700 bg-zinc-800 text-zinc-400',
    custom: 'border-blue-800/60 bg-blue-950/60 text-blue-400',
    outdated: 'border-amber-800/60 bg-amber-950/50 text-amber-400',
    error: 'border-red-800/60 bg-red-950/50 text-red-400',
  }

  let prompts = $state<PromptInfo[]>([])
  let loading = $state(true)
  let editing = $state<Editing | null>(null)
  let confirmingReset = $state<PromptId | null>(null)
  let failure = $state<string | null>(null)

  const current = $derived(editing ? prompts.find((p) => p.id === editing?.id) : undefined)
  const dirty = $derived(editing !== null && editing.text !== editing.saved)

  async function load(): Promise<void> {
    prompts = await window.api.invoke('prompts:list')
  }

  onMount(() => {
    let cancelled = false
    void (async () => {
      const list = await window.api.invoke('prompts:list')
      if (cancelled) return
      prompts = list
      loading = false
    })()
    return () => {
      cancelled = true
    }
  })

  /** Run an action, surfacing a failure instead of leaving the pane silently stale. */
  async function attempt(action: () => Promise<void>): Promise<void> {
    failure = null
    try {
      await action()
    } catch (err: unknown) {
      failure = err instanceof Error ? err.message : String(err)
    }
  }

  function open(id: PromptId, mode: Editing['mode']): Promise<void> {
    return attempt(async () => {
      const { text, defaultText } = await window.api.invoke('prompts:read', id)
      confirmingReset = null
      editing = { id, saved: text, text, defaultText, mode }
    })
  }

  function customize(id: PromptId): Promise<void> {
    return attempt(async () => {
      await window.api.invoke('prompts:customize', id)
      await load()
      await open(id, 'edit')
    })
  }

  function save(): Promise<void> {
    const target = editing
    if (!target) return Promise.resolve()
    const text = target.text
    return attempt(async () => {
      await window.api.invoke('prompts:save', target.id, text)
      if (editing?.id === target.id) editing = { ...editing, saved: text }
      await load()
    })
  }

  function reset(id: PromptId): Promise<void> {
    return attempt(async () => {
      await window.api.invoke('prompts:reset', id)
      confirmingReset = null
      if (editing?.id === id) editing = null
      await load()
    })
  }

  function reveal(id: PromptId): Promise<void> {
    return attempt(() => window.api.invoke('prompts:reveal', id))
  }

  function outdatedHint(p: PromptInfo): string {
    return `Customized from default v${p.basedOn}; SimpleEdit now ships v${p.defaultVersion}. Compare to see what changed.`
  }

  const buttonClass =
    'rounded-md border border-zinc-600 bg-zinc-800 px-2.5 py-1 text-[12px] font-semibold text-zinc-100 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50'
</script>

{#snippet chip(p: PromptInfo)}
  <span
    class="rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide {STATUS_CLASS[p.status]}"
    title={p.status === 'outdated' ? outdatedHint(p) : p.error}
    data-testid="prompt-status-{p.id}"
  >
    {STATUS_LABEL[p.status]}
  </span>
{/snippet}

{#snippet resetControl(p: PromptInfo)}
  {#if confirmingReset === p.id}
    <span class="flex items-center gap-1.5 text-[12px] text-zinc-300">
      Reset to default?
      <button type="button" class="{buttonClass} border-red-800 text-red-300 hover:bg-red-950" onclick={() => reset(p.id)}>Reset</button>
      <button type="button" class={buttonClass} onclick={() => (confirmingReset = null)}>Keep</button>
    </span>
  {:else}
    <button type="button" class={buttonClass} onclick={() => (confirmingReset = p.id)} aria-label="Reset {p.title}">Reset</button>
  {/if}
{/snippet}

<div>
  <h1 class="text-xl font-semibold tracking-tight text-zinc-100">Prompts</h1>
  <p class="mt-1 max-w-[64ch] text-[13px] text-zinc-400">
    Change what Screen PRs asks its models to look for. An override replaces only the
    <span class="text-zinc-200">instructions</span> — SimpleEdit still adds the output format and the PR itself, so a
    custom prompt can’t break parsing. Edits apply from the next run; cached results for the old text are ignored.
  </p>

  {#if failure}
    <p class="mt-4 max-w-[640px] rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-[12.5px] text-red-300" role="alert">
      {failure}
    </p>
  {/if}

  {#if loading}
    <p class="mt-8 text-sm text-zinc-500">Loading…</p>
  {:else if editing && current}
    <div class="mt-5 flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <button type="button" class="text-[12.5px] text-blue-400 hover:underline" onclick={() => (editing = null)}>
          ← All prompts
        </button>
        <span class="text-sm font-semibold text-zinc-100">{current.title}</span>
        {@render chip(current)}
        <div class="flex-1"></div>
        {#if dirty}<span class="text-[12px] text-zinc-500">Unsaved changes</span>{/if}
        <button
          type="button"
          class="rounded-md bg-blue-600 px-3 py-1 text-[12.5px] font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!dirty}
          onclick={save}
        >
          Save
        </button>
      </div>

      <div class="flex items-center gap-3">
        <div class="flex rounded-md border border-zinc-700 p-0.5" role="group" aria-label="View">
          {#each MODES as tab (tab.mode)}
            <button
              type="button"
              aria-pressed={editing.mode === tab.mode}
              onclick={() => editing && (editing = { ...editing, mode: tab.mode })}
              class="rounded px-2.5 py-1 text-[12px] font-semibold transition-colors
                {editing.mode === tab.mode ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-100'}"
            >
              {tab.label}
            </button>
          {/each}
        </div>
        <div class="flex-1"></div>
        <button type="button" class={buttonClass} onclick={() => reveal(current.id)}>Reveal in Finder</button>
        {@render resetControl(current)}
      </div>

      {#if current.error}
        <p class="text-[12px] text-red-400">{current.error}</p>
      {:else if current.status === 'outdated'}
        <p class="text-[12px] text-amber-400">{outdatedHint(current)}</p>
      {/if}

      <div class="h-[420px] overflow-hidden rounded-lg border border-zinc-700">
        {#if editing.mode === 'edit'}
          {#key editing.id}
            <PromptEditor
              value={editing.text}
              label="Instructions for {current.title}"
              onchange={(text) => editing && (editing = { ...editing, text })}
            />
          {/key}
        {:else}
          <MonacoDiffEditor
            originalContent={editing.defaultText}
            modifiedContent={editing.text}
            filePath="{current.id}.md"
            inline={false}
          />
        {/if}
      </div>
      <p class="font-mono text-[11.5px] text-zinc-500">{current.path}</p>
    </div>
  {:else}
    {#each GROUPS as group (group.id)}
      {@const rows = prompts.filter((p) => p.group === group.id)}
      {#if rows.length}
        <section class="mt-6 max-w-[720px]" aria-label={group.label}>
          <div class="pb-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">{group.label}</div>
          {#each rows as p (p.id)}
            <div class="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-zinc-800 py-3 last:border-b-0" data-testid="prompt-row-{p.id}">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold text-zinc-100">{p.title}</span>
                  {@render chip(p)}
                </div>
                <div class="mt-0.5 text-[12px] text-zinc-400">{p.description}</div>
                {#if p.error}
                  <div class="mt-0.5 text-[12px] text-red-400">{p.error}</div>
                {/if}
              </div>
              <div class="flex items-center gap-1.5">
                {#if p.status === 'default'}
                  <button type="button" class={buttonClass} onclick={() => customize(p.id)} aria-label="Customize {p.title}">Customize</button>
                {:else}
                  <button type="button" class={buttonClass} onclick={() => open(p.id, 'edit')} aria-label="Edit {p.title}">Edit</button>
                  <button type="button" class={buttonClass} onclick={() => open(p.id, 'compare')} aria-label="Compare {p.title} with default">Compare</button>
                  <button type="button" class={buttonClass} onclick={() => reveal(p.id)} aria-label="Reveal {p.title} in Finder">Reveal</button>
                  {@render resetControl(p)}
                {/if}
              </div>
            </div>
          {/each}
        </section>
      {/if}
    {/each}
  {/if}
</div>
