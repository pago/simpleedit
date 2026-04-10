<script lang="ts">
  import PlanPanel from './PlanPanel.svelte'
  import { planStore, planKey, triggerPlanFromDescription } from '../../stores/planStore.svelte'
  import type { AgentTabInfo } from '../../stores/agentTerminals.svelte'

  interface Props {
    worktreePath: string
    commitHash?: string | null
    terminals: AgentTabInfo[]
    onclose: () => void
    onsendtoagent?: (terminalId: string | 'new', message: string) => string | undefined
  }

  let { worktreePath, commitHash = 'user-plan', terminals, onclose, onsendtoagent }: Props = $props()

  let description = $state('')
  let inputExpanded = $state(false)
  /** When true, override the Claude plan view to show the user-plan input instead. */
  let showingUserPlan = $state(false)

  const baseHash = $derived(commitHash ?? 'user-plan')
  const effectiveHash = $derived(showingUserPlan ? 'user-plan' : baseHash)
  const key = $derived(planKey(worktreePath, effectiveHash))
  const planState = $derived(planStore.get(key))
  const isGenerating = $derived(planState?.status === 'running' || planState?.status === 'revising')
  const hasPlan = $derived(planState && planState.tasks.length > 0)
  const isFromClaude = $derived(!!planState?.sourceTerminalId)
  /** True when the original commitHash points to a Claude plan (even if we're showing user plan). */
  const hasClaudePlan = $derived(baseHash !== 'user-plan' && baseHash !== null)

  function handleGenerate(): void {
    const text = description.trim()
    if (!text) return
    triggerPlanFromDescription(worktreePath, text)
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleGenerate()
    }
  }

  function switchToUserPlan(): void {
    showingUserPlan = true
  }

  function switchToClaudePlan(): void {
    showingUserPlan = false
    inputExpanded = false
  }
</script>

<div class="flex h-full flex-col">
  <!-- Header -->
  <div class="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
    <button
      class="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
      onclick={onclose}
    >
      &larr; Back
    </button>
    <span class="text-xs font-medium text-zinc-300">Plan</span>
  </div>

  <!-- Content -->
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Description input area -->
    {#if isFromClaude && !inputExpanded}
      <!-- Claude plan active — offer to create a new user plan -->
      <button
        class="flex w-full items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-4 py-2 text-left text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-400"
        onclick={switchToUserPlan}
      >
        <span>✦ New plan...</span>
        <span class="text-[10px] text-zinc-600">(replaces Claude plan)</span>
      </button>
    {:else if !isFromClaude && (hasPlan || showingUserPlan) && !inputExpanded}
      <!-- Existing user plan or just switched from Claude — show collapsed trigger -->
      {#if showingUserPlan && hasClaudePlan}
        <button
          class="flex w-full items-center gap-2 border-b border-zinc-800/50 bg-zinc-950 px-4 py-1 text-left text-[10px] text-zinc-600 hover:text-zinc-400"
          onclick={switchToClaudePlan}
        >
          &larr; Back to Claude plan
        </button>
      {/if}
      <button
        class="flex w-full items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-4 py-2 text-left text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-400"
        onclick={() => (inputExpanded = true)}
      >
        <span>✦ New plan…</span>
        <span class="text-[10px] text-zinc-600">{hasClaudePlan ? '(replaces Claude plan)' : '(replaces current)'}</span>
      </button>
    {:else if inputExpanded || (!isFromClaude && !hasPlan && !showingUserPlan)}
      <!-- Expanded description input form -->
      {#if showingUserPlan && hasClaudePlan && !isGenerating}
        <button
          class="flex w-full items-center gap-2 border-b border-zinc-800/50 bg-zinc-950 px-4 py-1 text-left text-[10px] text-zinc-600 hover:text-zinc-400"
          onclick={switchToClaudePlan}
        >
          &larr; Back to Claude plan
        </button>
      {/if}
      <div class="border-b border-zinc-800 bg-zinc-950 px-4 py-3">
        <div class="flex items-center justify-between">
          <label class="mb-1.5 block text-xs font-medium text-zinc-400">
            {hasPlan || (showingUserPlan && hasClaudePlan) ? 'Replace current plan' : 'What would you like to plan?'}
          </label>
          {#if hasPlan || (showingUserPlan && hasClaudePlan)}
            <button
              class="mb-1.5 text-[10px] text-zinc-600 hover:text-zinc-400"
              onclick={() => { inputExpanded = false; if (hasClaudePlan) switchToClaudePlan() }}
            >✕</button>
          {/if}
        </div>
        <textarea
          bind:value={description}
          class="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
          rows="3"
          placeholder="e.g. Add user authentication with OAuth, refactor the file tree for lazy loading, implement keyboard shortcuts for pane navigation…"
          onkeydown={handleKeydown}
          disabled={isGenerating}
        ></textarea>
        <div class="mt-2 flex items-center gap-2">
          <button
            class="rounded bg-purple-700/80 px-3 py-1.5 text-xs text-purple-200 hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-40"
            onclick={handleGenerate}
            disabled={!description.trim() || isGenerating}
          >
            {#if isGenerating}
              <span class="inline-flex items-center gap-1.5">
                <span class="animate-spin text-[10px]">⠿</span>
                {planState?.status === 'revising' ? 'Revising…' : 'Planning…'}
              </span>
            {:else if hasPlan}
              ✦ Re-plan
            {:else}
              ✦ Generate Plan
            {/if}
          </button>
          <span class="text-[10px] text-zinc-600">
            {#if !isGenerating}
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to generate
            {/if}
          </span>
        </div>
      </div>
    {/if}

    <!-- Plan panel handles its own IPC subscriptions and rendering -->
    <div class="min-h-0 flex-1">
      <PlanPanel
        {worktreePath}
        commitHash={effectiveHash}
        {terminals}
        {onsendtoagent}
        hideEmptyInput
      />
    </div>
  </div>
</div>
