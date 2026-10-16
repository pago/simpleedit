<script lang="ts">
  /**
   * The review companion's bar and docked terminal. The bar always shows
   * (terminal toggle, agent picker, status); the terminal is mounted only in
   * the window hosting the companion, only while expanded, and it never
   * expands on its own, a permission prompt included: that shows as "needs you".
   */
  import { onMount } from 'svelte'
  import type { InteractiveTarget } from '../../../shared/ipc-types'
  import type { Review, ReviewAgent } from '../../../shared/review-room'
  import type { ReviewCompanionInfo } from '../../../shared/review-room-ipc'
  import { sessionsStore } from '../../stores/sessions.svelte'
  import { getAgentStatusForTerminal } from '../../stores/agent-status.svelte'
  import { ALLOWLIST_HINT, loadAllowlistedModels, refreshAllowlistedModelsOnFocus, targetKey, type AllowlistedModel } from '../../lib/agentModels'
  import Terminal from '../terminal/Terminal.svelte'

  interface Props {
    reviewId: string
    review: Review
  }

  let { reviewId, review }: Props = $props()

  let expanded = $state(false)
  let info = $state<ReviewCompanionInfo | null>(null)
  let starting = $state(false)
  let error = $state<string | null>(null)

  let companion = $derived(review.companion)
  let local = $derived(companion ? sessionsStore.get(companion.sessionId) : undefined)
  /** A restored companion: its placeholder may carry a fresh terminal id until main rebinds the claim. */
  let placeholder = $derived(
    sessionsStore.sessions().find((s) => s.owner?.kind === 'review' && s.owner.reviewId === reviewId && s.pendingResume),
  )

  // Main derives where the companion lives; ask again whenever the claim or
  // this window's copy of the session changes.
  $effect(() => {
    const id = companion?.sessionId
    void companion?.windowId
    void local?.pendingResume
    void local?.exited
    void placeholder?.id
    if (local) void getAgentStatusForTerminal(local.id)
    if (!id) {
      info = null
      return
    }
    let cancelled = false
    window.api
      .invoke('review:companion-info', reviewId)
      .then((next) => {
        if (!cancelled) info = next
      })
      .catch((err: unknown) => console.warn('[review] companion info failed:', err))
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    if (companion) starting = false
  })

  type DockState = 'none' | 'starting' | 'running' | 'idle' | 'waiting' | 'resume' | 'ended' | 'elsewhere'

  let dock = $derived.by((): DockState => {
    if (!companion) return starting ? 'starting' : 'none'
    if (info && !info.hostedHere) return 'elsewhere'
    if (info && !info.live) return placeholder ? 'resume' : 'ended'
    if (!info && placeholder) return 'resume'
    if (!local || local.exited) return info ? 'ended' : 'starting'
    switch (getAgentStatusForTerminal(local.id)) {
      case 'initializing':
        return 'starting'
      case 'running':
        return 'running'
      case 'waiting':
        return 'waiting'
      case 'idle':
        return 'idle'
      default:
        return 'ended'
    }
  })

  const LABEL: Record<DockState, string> = {
    none: 'Not started',
    starting: 'Starting…',
    running: 'Working',
    idle: 'Idle',
    waiting: 'Needs you',
    resume: 'Paused since SimpleEdit restarted',
    ended: 'Ended',
    elsewhere: 'Terminal lives in another window',
  }
  const DOT: Record<DockState, string> = {
    none: 'bg-zinc-600',
    starting: 'bg-violet-400 animate-pulse',
    running: 'bg-violet-400 animate-pulse',
    idle: 'bg-violet-400',
    waiting: 'bg-red-400 animate-pulse',
    resume: 'bg-zinc-500',
    ended: 'bg-zinc-600',
    elsewhere: 'bg-violet-400/60',
  }

  let hostable = $derived(!!local && !local.exited && !local.pendingResume && (dock === 'starting' || dock === 'running' || dock === 'idle' || dock === 'waiting'))
  let terminalShown = $derived(expanded && hostable)
  let readOnlyHint = $derived(info?.readOnly === 'by-instruction' ? 'Read-only by instruction: this agent can’t be held to it, the brief asks it not to change files.' : info?.readOnly === 'enforced' ? 'Read-only, enforced by the agent’s own settings.' : undefined)

  async function start(): Promise<void> {
    error = null
    starting = true
    try {
      await window.api.invoke('review:companion-start', reviewId)
    } catch (err) {
      starting = false
      error = err instanceof Error ? err.message : String(err)
    }
  }

  function resume(): void {
    if (placeholder) sessionsStore.resumePlaceholder(placeholder.id)
  }

  // ── Agent picker: "Default" plus Settings → Models ──
  let models = $state<AllowlistedModel[]>([])
  let modelsLoaded = $state(false)

  function takeModels(load: Promise<AllowlistedModel[]> | null): void {
    load
      ?.then((list) => {
        models = list
        modelsLoaded = true
      })
      .catch(() => {})
  }
  const refreshModels = (): void => takeModels(loadAllowlistedModels())
  const onWindowFocus = (): void => takeModels(refreshAllowlistedModelsOnFocus())

  onMount(() => {
    refreshModels()
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  })

  function isAgent(target: InteractiveTarget, agent: ReviewAgent): boolean {
    if (target.provider !== agent.provider) return false
    const model = target.provider === 'claude' ? target.model?.model : target.model
    return (model ?? '') === agent.model
  }

  let picked = $derived(models.find((m) => isAgent(m.target, review.companionAgent)))
  let pickedKey = $derived(picked ? targetKey(picked.target) : '')

  async function pick(key: string): Promise<void> {
    error = null
    const target = models.find((m) => targetKey(m.target) === key)?.target ?? null
    try {
      await window.api.invoke('review:set-companion-agent', reviewId, target ? $state.snapshot(target) : null)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }
</script>

<div class="flex-none border-t border-zinc-800 bg-zinc-900" data-testid="companion-dock">
  <div class="flex flex-wrap items-center gap-2.5 px-4 py-1.5 text-[12px]">
    <button
      type="button"
      class="rounded border border-zinc-700 px-2 py-0.5 text-[11.5px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
      aria-expanded={terminalShown}
      disabled={!hostable}
      title={hostable ? undefined : 'The terminal is there once the companion runs in this window'}
      onclick={() => (expanded = !expanded)}
    >{terminalShown ? '▾ Terminal' : '▸ Terminal'}</button>
    <label class="flex items-center gap-1.5">
      <span class="sr-only">Review companion</span>
      <select
        class="max-w-[14rem] rounded border border-transparent bg-violet-500/15 px-1.5 py-0.5 text-[11.5px] font-semibold text-violet-300 outline-none focus:border-violet-500"
        aria-label="Review companion agent and model"
        value={pickedKey}
        onfocus={refreshModels}
        onchange={(e) => void pick(e.currentTarget.value)}
      >
        <option value="">Default</option>
        {#each models as m (m.key)}<option value={targetKey(m.target)}>{m.label}</option>{/each}
      </select>
    </label>
    <span class="inline-flex items-center gap-1.5 text-zinc-200" title={readOnlyHint} data-testid="companion-status">
      <span class="h-2 w-2 rounded-full {DOT[dock]}" aria-hidden="true"></span>{LABEL[dock]}
    </span>
    {#if dock === 'waiting'}
      <span class="rounded-full bg-red-500 px-2 py-px text-[10.5px] font-bold text-white" data-testid="needs-you">needs you · open the terminal</span>
    {/if}
    {#if dock === 'none'}
      <span class="text-[11px] text-zinc-500">Starts on your first question.</span>
    {/if}
    {#if modelsLoaded && models.length === 0}
      <span class="text-[11px] text-zinc-500">{ALLOWLIST_HINT}</span>
    {/if}
    {#if error}<span role="alert" class="text-[11px] text-red-300">{error}</span>{/if}
    <span class="flex-1"></span>
    {#if dock === 'none' || dock === 'ended'}
      <button type="button" class="rounded bg-violet-500/15 px-2.5 py-0.5 text-[11.5px] font-semibold text-violet-300 hover:bg-violet-500/25" onclick={start}>{dock === 'ended' ? 'Start a new companion' : 'Start'}</button>
    {:else if dock === 'resume'}
      <button type="button" class="rounded bg-violet-500/15 px-2.5 py-0.5 text-[11.5px] font-semibold text-violet-300 hover:bg-violet-500/25" onclick={resume}>Resume</button>
    {/if}
  </div>
  {#if terminalShown && local}
    <div class="h-[min(42vh,360px)] border-t border-zinc-800 bg-black" data-testid="companion-terminal">
      <Terminal terminalId={local.id} active={terminalShown} provider={local.provider} />
    </div>
  {/if}
</div>
