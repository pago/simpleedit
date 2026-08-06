<script lang="ts">
  import { onMount } from 'svelte'
  import type {
    ClaudeModel,
    CodexModel,
    HardwareInfo,
    ModelConfig,
    ModelDescriptor,
    RecommendedModel,
  } from '../../../shared/ipc-types'
  import Toggle from './Toggle.svelte'
  import { fitClasses, fitLabel, formatEstimate, formatGb } from './model-format'

  let available = $state(false)
  let hardware = $state<HardwareInfo | null>(null)
  let claude = $state<ClaudeModel[]>([])
  let codex = $state<CodexModel[]>([])
  let codexAvailable = $state(false)
  let installed = $state<ModelDescriptor[]>([])
  let recommended = $state<RecommendedModel[]>([])
  let config = $state<ModelConfig | null>(null)
  let loading = $state(true)

  interface PullEntry {
    pct: number
    label: string
    failed?: boolean
  }
  let pulls = $state<Record<string, PullEntry>>({})

  const allowlist = $derived(new Set(config?.submenuAllowlist ?? []))

  // Agent-capable models first, then review-only.
  const sortedInstalled = $derived(
    [...installed].sort((a, b) => Number(b.toolCapable) - Number(a.toolCapable))
  )

  const FIT_ORDER = { fits: 0, marginal: 1, 'too-big': 2 } as const
  const sortedRecommended = $derived(
    [...recommended].sort((a, b) => FIT_ORDER[a.fit] - FIT_ORDER[b.fit])
  )

  const hardwareLine = $derived(
    hardware ? `${hardware.chip} · ${formatGb(hardware.totalRamBytes)}` : ''
  )

  async function reloadLists(): Promise<void> {
    installed = available
      ? await window.api.invoke('models:installed').catch(() => [])
      : []
    recommended = await window.api.invoke('models:recommended').catch(() => [])
  }

  onMount(() => {
    let cancelled = false

    void (async () => {
      const [avail, hw, cl, cfg, cx, cxAvail] = await Promise.all([
        window.api.invoke('models:available'),
        window.api.invoke('models:hardware'),
        window.api.invoke('models:claude'),
        window.api.invoke('models:config-get'),
        // Discovery shells out to `codex app-server`; a missing or unhappy CLI
        // must leave the rest of the pane working.
        window.api.invoke('models:codex').catch(() => [] as CodexModel[]),
        window.api.invoke('agent:available', 'codex').catch(() => false),
      ])
      if (cancelled) return
      available = avail
      hardware = hw
      claude = cl
      config = cfg
      codex = cx
      codexAvailable = cxAvail
      await reloadLists()
      if (!cancelled) loading = false
    })()

    const unsub = window.api.on('models:pull-progress', (p) => {
      const current = pulls[p.name]
      if (!current) return
      const pct =
        p.total && p.total > 0
          ? Math.min(100, Math.round(((p.completed ?? 0) / p.total) * 100))
          : current.pct
      pulls[p.name] = { pct, label: p.status }
    })

    return () => {
      cancelled = true
      unsub()
    }
  })

  async function toggleSubmenu(id: string, next: boolean): Promise<void> {
    if (!config) return
    const set = new Set(config.submenuAllowlist)
    if (next) set.add(id)
    else set.delete(id)
    config = await window.api.invoke('models:config-set', { submenuAllowlist: [...set] })
  }

  async function install(name: string): Promise<void> {
    pulls[name] = { pct: 0, label: 'Starting…' }
    try {
      await window.api.invoke('models:pull', name)
    } catch {
      pulls[name] = { pct: pulls[name]?.pct ?? 0, label: 'Install failed', failed: true }
      return
    }
    delete pulls[name]
    await reloadLists()
    // Newly installed model may now be curated on by default via the allowlist;
    // refresh config so its toggle reflects reality.
    config = await window.api.invoke('models:config-get')
  }
</script>

<div>
  <!-- Header -->
  <div class="flex items-start justify-between gap-4">
    <div class="min-w-0">
      <h1 class="text-xl font-semibold tracking-tight text-zinc-100">Models</h1>
      <p class="mt-1 max-w-[62ch] text-[13px] text-zinc-400">
        Toggle which models appear in the <span class="font-medium text-zinc-300">⌘K quick picker</span>
        when you start a session. Install recommended local models on demand.
      </p>
    </div>
    <div
      class="flex flex-none items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-400"
    >
      {#if available}
        <span class="h-[7px] w-[7px] rounded-full bg-green-500"></span>
        <span>Ollama detected</span>
        {#if hardwareLine}
          <span class="text-zinc-600">·</span>
          <span class="font-mono text-[11.5px] text-zinc-400">{hardwareLine}</span>
        {/if}
      {:else}
        <span class="h-[7px] w-[7px] rounded-full bg-zinc-600"></span>
        <span>Ollama not detected</span>
      {/if}
    </div>
  </div>

  {#if loading}
    <p class="mt-8 text-sm text-zinc-500">Loading models…</p>
  {:else}
    <!-- Claude · cloud -->
    <section class="mt-5">
      <div
        class="flex items-baseline justify-between border-b border-zinc-800 px-0.5 pb-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500"
      >
        <span>Claude · cloud</span>
        <span class="text-[11px] font-medium normal-case tracking-normal text-zinc-500">
          on your plan — no API key
        </span>
      </div>
      {#each claude as model (model.model)}
        <div class="grid grid-cols-[1fr_auto_auto] items-center gap-3.5 border-b border-zinc-800 px-1.5 py-2.5 last:border-b-0">
          <div class="min-w-0">
            <div class="font-mono text-[13px] font-semibold text-zinc-100">{model.displayName}</div>
            <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-zinc-400">
              <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10.5px] font-semibold text-zinc-400">cloud</span>
              <span class="rounded bg-blue-950/60 px-1.5 py-0.5 text-[10.5px] font-semibold text-blue-400">agent</span>
            </div>
          </div>
          <span class="rounded-full bg-zinc-800 px-2 py-1 text-[11px] font-semibold text-zinc-500">on plan</span>
          <Toggle
            checked={allowlist.has(model.model)}
            label="Show {model.displayName} in quick picker"
            onchange={(v) => toggleSubmenu(model.model, v)}
          />
        </div>
      {/each}
    </section>

    <!-- Codex · cloud -->
    <section class="mt-6">
      <div
        class="flex items-baseline justify-between border-b border-zinc-800 px-0.5 pb-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500"
      >
        <span>Codex · cloud</span>
        <span class="text-[11px] font-medium normal-case tracking-normal text-zinc-500">
          on your ChatGPT plan — no API key
        </span>
      </div>
      {#if codex.length === 0}
        <p class="px-1.5 py-3 text-[12px] text-zinc-500">
          {codexAvailable
            ? 'Codex is installed but its model catalog is unavailable right now.'
            : 'Install the Codex CLI and sign in to use Codex sessions.'}
        </p>
      {:else}
        {#each codex as model (model.model)}
          <div class="grid grid-cols-[1fr_auto_auto] items-center gap-3.5 border-b border-zinc-800 px-1.5 py-2.5 last:border-b-0">
            <div class="min-w-0">
              <div class="font-mono text-[13px] font-semibold text-zinc-100">{model.displayName}</div>
              <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-zinc-400">
                <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10.5px] font-semibold text-zinc-400">cloud</span>
                <span class="rounded bg-blue-950/60 px-1.5 py-0.5 text-[10.5px] font-semibold text-blue-400">agent</span>
                {#if model.supportedReasoningEfforts.length > 0}
                  <span class="font-mono tabular-nums text-zinc-400">
                    {model.supportedReasoningEfforts.join(' · ')}
                  </span>
                {/if}
              </div>
            </div>
            <span class="rounded-full bg-zinc-800 px-2 py-1 text-[11px] font-semibold text-zinc-500">
              {model.isDefault ? 'default' : 'on plan'}
            </span>
            <Toggle
              checked={allowlist.has(model.model)}
              label="Show {model.displayName} in quick picker"
              onchange={(v) => toggleSubmenu(model.model, v)}
            />
          </div>
        {/each}
        <p class="px-1.5 pt-2.5 text-[11.5px] text-zinc-500">
          Sessions started from the picker use each model's default reasoning effort.
          Set a specific effort under <span class="text-zinc-400">Default Model</span>.
        </p>
      {/if}
    </section>

    <!-- Installed · local -->
    <section class="mt-6">
      <div
        class="flex items-baseline justify-between border-b border-zinc-800 px-0.5 pb-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500"
      >
        <span>Installed · local</span>
        <span class="text-[11px] font-medium normal-case tracking-normal text-zinc-500">
          tool-capable models can run the interactive agent
        </span>
      </div>
      {#if sortedInstalled.length === 0}
        <p class="px-1.5 py-3 text-[12px] text-zinc-500">
          {available ? 'No local models installed yet.' : 'Start Ollama to see installed models.'}
        </p>
      {:else}
        {#each sortedInstalled as model (model.name)}
          <div class="grid grid-cols-[1fr_auto_auto] items-center gap-3.5 border-b border-zinc-800 px-1.5 py-2.5 last:border-b-0">
            <div class="min-w-0">
              <div class="font-mono text-[13px] font-semibold text-zinc-100">{model.name}</div>
              <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-zinc-400">
                <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10.5px] font-semibold text-zinc-400">local</span>
                {#if model.toolCapable}
                  <span class="rounded bg-blue-950/60 px-1.5 py-0.5 text-[10.5px] font-semibold text-blue-400">agent</span>
                {:else}
                  <span class="rounded border border-dashed border-zinc-600 bg-zinc-800 px-1.5 py-0.5 text-[10.5px] font-semibold text-zinc-500">review only</span>
                {/if}
                <span class="font-mono tabular-nums text-zinc-400">
                  {[model.paramSize, model.quantization, formatEstimate(model.minRamBytes)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {#if !model.toolCapable}
                  <span class="text-zinc-500">· no tool-calling on Ollama</span>
                {/if}
              </div>
            </div>
            <span class="rounded-full px-2 py-1 text-[11px] font-semibold tabular-nums {fitClasses(model.fit)}">
              {fitLabel(model.fit)}
            </span>
            <Toggle
              checked={allowlist.has(model.name)}
              disabled={!model.toolCapable}
              label={model.toolCapable
                ? `Show ${model.name} in quick picker`
                : `${model.name} cannot run the interactive agent`}
              onchange={(v) => toggleSubmenu(model.name, v)}
            />
          </div>
        {/each}
      {/if}
    </section>

    <!-- Recommended · not installed -->
    <section class="mt-6">
      <div
        class="flex items-baseline justify-between border-b border-zinc-800 px-0.5 pb-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500"
      >
        <span>Recommended · not installed</span>
        <span class="text-[11px] font-medium normal-case tracking-normal text-zinc-500">
          curated for your machine
        </span>
      </div>
      {#if sortedRecommended.length === 0}
        <p class="px-1.5 py-3 text-[12px] text-zinc-500">Everything recommended is already installed.</p>
      {:else}
        {#each sortedRecommended as model (model.name)}
          {@const pull = pulls[model.name]}
          <div class="grid grid-cols-[1fr_auto_auto] items-center gap-3.5 border-b border-zinc-800 px-1.5 py-2.5 last:border-b-0">
            <div class="min-w-0">
              <div class="font-mono text-[13px] font-semibold text-zinc-100">{model.name}</div>
              <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-zinc-400">
                <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10.5px] font-semibold text-zinc-400">local</span>
                <span class="rounded bg-blue-950/60 px-1.5 py-0.5 text-[10.5px] font-semibold text-blue-400">agent</span>
                <span class="font-mono tabular-nums text-zinc-400">{formatEstimate(model.minRamBytes)}</span>
                {#if model.notes}
                  <span class="text-zinc-500">· {model.notes}</span>
                {/if}
              </div>
            </div>
            <span class="rounded-full px-2 py-1 text-[11px] font-semibold tabular-nums {fitClasses(model.fit)}">
              {fitLabel(model.fit)}
            </span>
            {#if pull}
              <div class="flex min-w-[132px] flex-col gap-1.5">
                <div class="flex justify-between text-[11px] tabular-nums text-zinc-400">
                  <span>{pull.label}</span>
                  {#if !pull.failed}<span>{pull.pct}%</span>{/if}
                </div>
                <div class="h-[5px] overflow-hidden rounded-full bg-zinc-800">
                  <span
                    class="block h-full rounded-full transition-[width] duration-300 {pull.failed ? 'bg-red-500' : 'bg-blue-500'}"
                    style:width="{pull.pct}%"
                  ></span>
                </div>
              </div>
            {:else}
              <button
                type="button"
                disabled={model.fit === 'too-big' || !available}
                title={model.fit === 'too-big'
                  ? `Needs ${formatEstimate(model.minRamBytes)} RAM`
                  : !available
                    ? 'Start Ollama to install'
                    : undefined}
                onclick={() => install(model.name)}
                class="rounded-md border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-[12.5px] font-semibold text-zinc-100 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Install
              </button>
            {/if}
          </div>
        {/each}
      {/if}
    </section>

    <p class="mt-4 text-[11.5px] text-zinc-500">
      Finding models:
      <a href="https://aider.chat/docs/leaderboards/" target="_blank" rel="noreferrer" class="text-blue-400 hover:underline">Aider leaderboard ↗</a>
      · <a href="https://www.reddit.com/r/LocalLLaMA/" target="_blank" rel="noreferrer" class="text-blue-400 hover:underline">r/LocalLLaMA ↗</a>
      · <a href="https://ollama.com/library" target="_blank" rel="noreferrer" class="text-blue-400 hover:underline">ollama.com/library ↗</a>
    </p>

    {#if hardware}
      <p class="mt-3 text-[11.5px] text-zinc-500">
        Fit is estimated for this machine ({hardwareLine}) at a 64k context window.
        “Too big” models are shown but can’t be installed here.
      </p>
    {/if}
  {/if}
</div>
