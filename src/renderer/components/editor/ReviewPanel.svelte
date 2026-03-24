<script lang="ts">
  import { reviewStore, reviewKey } from '../../stores/reviewStore.svelte'
  import type { ReviewFinding, ConventionalCommentLabel, ReviewFindingDecoration } from '../../../shared/ipc-types'
  import type { AgentContext } from '../../lib/agent-message'
  import type { AgentTabInfo } from '../../stores/agentTerminals.svelte'

  interface Props {
    worktreePath: string
    commitHash: string | null
    terminals: AgentTabInfo[]
    ondiscussfinding?: (ctx: AgentContext, pos: { x: number; y: number }) => void
    onnavigate?: (file: string, lineRange: [number, number]) => void
    onsendtoagent?: (terminalId: string | 'new', message: string) => void
  }

  let { worktreePath, commitHash, terminals, ondiscussfinding, onnavigate, onsendtoagent }: Props = $props()

  const key = $derived(reviewKey(worktreePath, commitHash))
  const state = $derived(reviewStore.get(key))

  // Subscribe to IPC events for this review target
  $effect(() => {
    const currentKey = key
    const unsubFinding = window.api.on('review:finding', (data) => {
      if (data.key === currentKey) reviewStore.addFinding(currentKey, data.finding)
    })
    const unsubStatus = window.api.on('review:status', (data) => {
      if (data.key === currentKey) reviewStore.setStatus(currentKey, data.status, data.error)
    })
    return () => { unsubFinding(); unsubStatus() }
  })

  // ── Display helpers ──────────────────────────────────────

  const LABEL_WEIGHT: Record<ConventionalCommentLabel, number> = {
    issue: 0, suggestion: 1, question: 2, thought: 3, nitpick: 4, chore: 5, praise: 6,
  }

  const LABEL_COLORS: Record<ConventionalCommentLabel, string> = {
    issue: 'text-red-400 bg-red-950/50 border-red-800/50',
    suggestion: 'text-blue-400 bg-blue-950/50 border-blue-800/50',
    question: 'text-amber-400 bg-amber-950/50 border-amber-800/50',
    thought: 'text-zinc-400 bg-zinc-800/50 border-zinc-700/50',
    nitpick: 'text-zinc-400 bg-zinc-800/50 border-zinc-700/50',
    chore: 'text-zinc-400 bg-zinc-800/50 border-zinc-700/50',
    praise: 'text-green-400 bg-green-950/50 border-green-800/50',
  }

  const DECORATION_COLORS: Record<ReviewFindingDecoration, string> = {
    blocking: 'text-red-300 bg-red-900/40',
    'non-blocking': 'text-zinc-400 bg-zinc-800',
    'if-minor': 'text-zinc-400 bg-zinc-800',
  }

  function sortedFindings(findings: ReviewFinding[], dismissed: Set<string>): ReviewFinding[] {
    return [...findings]
      .filter((f) => !dismissed.has(f.id))
      .sort((a, b) => {
        const aB = a.decoration === 'blocking' ? 0 : 1
        const bB = b.decoration === 'blocking' ? 0 : 1
        if (aB !== bB) return aB - bB
        const wDiff = LABEL_WEIGHT[a.label] - LABEL_WEIGHT[b.label]
        if (wDiff !== 0) return wDiff
        return a.file.localeCompare(b.file)
      })
  }

  function dismissedFindings(findings: ReviewFinding[], dismissed: Set<string>): ReviewFinding[] {
    return findings.filter((f) => dismissed.has(f.id))
  }

  function fileName(path: string): string { return path.split('/').at(-1) ?? path }
  function dirName(path: string): string {
    const parts = path.split('/')
    return parts.length <= 1 ? '' : parts.slice(0, -1).join('/') + '/'
  }

  // ── Expand state ─────────────────────────────────────────

  let expandedIds = $state(new Set<string>())

  function toggleExpand(finding: ReviewFinding): void {
    const next = new Set(expandedIds)
    if (next.has(finding.id)) {
      next.delete(finding.id)
    } else {
      next.add(finding.id)
      onnavigate?.(finding.file, finding.lineRange)
    }
    expandedIds = next
  }

  // ── Single-finding discuss ────────────────────────────────

  function handleDiscuss(finding: ReviewFinding, e: MouseEvent): void {
    const btn = e.currentTarget as HTMLButtonElement
    const rect = btn.getBoundingClientRect()
    ondiscussfinding?.({ kind: 'finding', finding, commitHash }, { x: rect.right + 8, y: rect.top })
  }

  // ── Selection ────────────────────────────────────────────

  let selectedIds = $state(new Set<string>())

  function toggleSelect(id: string, e: Event): void {
    e.stopPropagation() // don't trigger expand
    const next = new Set(selectedIds)
    if (next.has(id)) { next.delete(id) } else { next.add(id) }
    selectedIds = next
  }

  function selectAll(findings: ReviewFinding[]): void {
    selectedIds = new Set(findings.map((f) => f.id))
  }

  function clearSelection(): void {
    selectedIds = new Set()
    showSendForm = false
  }

  function dismissSelected(): void {
    for (const id of selectedIds) reviewStore.dismiss(key, id)
    clearSelection()
  }

  // ── Bulk send form ───────────────────────────────────────

  let showSendForm = $state(false)
  let agentInstruction = $state('Please handle these review findings.')
  let selectedTerminalId = $state<string | 'new'>('new')

  // When terminals become available, prefer the first one
  $effect(() => {
    if (terminals.length > 0 && selectedTerminalId === 'new') {
      selectedTerminalId = terminals[0].id
    }
  })

  function buildBulkMessage(findings: ReviewFinding[]): string {
    const ref = commitHash ? `commit ${commitHash.slice(0, 7)}` : 'uncommitted changes'
    const header = agentInstruction.trim() || 'Please handle these review findings.'
    const items = findings.map((f) => {
      const dec = f.decoration ? ` (${f.decoration})` : ''
      return [
        `[${f.label}${dec}: ${f.file}, lines ${f.lineRange[0]}-${f.lineRange[1]}, ${ref}]`,
        `**${f.title}**`,
        f.body,
      ].join('\n')
    })
    return [header, ...items].join('\n\n')
  }

  function sendToAgent(findings: ReviewFinding[]): void {
    const message = buildBulkMessage(findings)
    onsendtoagent?.(selectedTerminalId, message)
    clearSelection()
  }

  // ── Dismissed section ────────────────────────────────────

  let showDismissed = $state(false)
</script>

<div class="flex h-full flex-col overflow-hidden">
  <!-- Status bar -->
  {#if state?.status === 'running'}
    <div class="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
      <span class="animate-spin">⠿</span>
      <span>Analyzing{state.findings.length > 0 ? ` · ${state.findings.length} so far` : ''}…</span>
    </div>
  {:else if state?.status === 'error'}
    <div class="border-b border-zinc-800 px-3 py-2 text-xs text-red-400">
      {state.error ?? 'Review failed'}
    </div>
  {:else if state?.status === 'done' && state.findings.length === 0}
    <div class="border-b border-zinc-800 px-3 py-2 text-xs text-green-400">
      No findings — looks good!
    </div>
  {/if}

  <!-- Findings list -->
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if !state || state.status === 'idle'}
      <p class="px-3 py-4 text-xs text-zinc-600">Click Review to analyze this diff.</p>
    {:else}
      {@const active = sortedFindings(state.findings, state.dismissed)}
      {@const gone = dismissedFindings(state.findings, state.dismissed)}

      {#if active.length > 0}
        <!-- Select-all row -->
        {@const allSelected = selectedIds.size === active.length}
        {@const someSelected = selectedIds.size > 0 && !allSelected}
        <!-- svelte-ignore a11y_interactive_supports_focus -->
        <div
          class="flex cursor-pointer items-center gap-2 border-b border-zinc-800/40 px-2 py-1 hover:bg-zinc-800/30"
          role="checkbox"
          aria-checked={allSelected ? true : someSelected ? 'mixed' : false}
          onclick={() => (allSelected || someSelected ? clearSelection() : selectAll(active))}
        >
          <span class="flex h-3.5 w-3.5 flex-none items-center justify-center rounded-[3px] border transition-colors
            {allSelected
              ? 'border-blue-500 bg-blue-600'
              : someSelected
                ? 'border-blue-500 bg-blue-950'
                : 'border-zinc-600 bg-zinc-900'}">
            {#if allSelected}
              <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                <path d="M1 3.5L3.5 6L8 1" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            {:else if someSelected}
              <svg width="7" height="2" viewBox="0 0 7 2" fill="none">
                <path d="M1 1H6" stroke="#93c5fd" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            {/if}
          </span>
          <span class="text-[10px] text-zinc-600">
            {selectedIds.size > 0 ? `${selectedIds.size} of ${active.length} selected` : `${active.length} finding${active.length !== 1 ? 's' : ''}`}
          </span>
        </div>
      {/if}

      {#each active as finding (finding.id)}
        {@const isSelected = selectedIds.has(finding.id)}
        <div class="border-b border-zinc-800/60">
          <div class="flex items-start {isSelected ? 'bg-blue-950/20' : ''}">
            <!-- Custom checkbox -->
            <!-- svelte-ignore a11y_interactive_supports_focus -->
            <div
              class="flex flex-none cursor-pointer items-center px-2 py-2.5"
              role="checkbox"
              aria-checked={isSelected}
              onclick={(e) => toggleSelect(finding.id, e)}
            >
              <span class="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border transition-colors
                {isSelected ? 'border-blue-500 bg-blue-600' : 'border-zinc-600 bg-zinc-900 hover:border-zinc-400'}">
                {#if isSelected}
                  <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                    <path d="M1 3.5L3.5 6L8 1" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
              </span>
            </div>

            <!-- Header button (expand + navigate) -->
            <button
              class="flex min-w-0 flex-1 cursor-pointer items-start gap-2 py-2 pr-2 text-left hover:bg-zinc-800/40"
              onclick={() => toggleExpand(finding)}
            >
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <div class="flex flex-wrap items-center gap-1">
                  <span class="rounded border px-1 py-0.5 font-mono text-[10px] {LABEL_COLORS[finding.label]}">
                    {finding.label}
                  </span>
                  {#if finding.decoration}
                    <span class="rounded px-1 py-0.5 font-mono text-[10px] {DECORATION_COLORS[finding.decoration]}">
                      {finding.decoration}
                    </span>
                  {/if}
                </div>
                <p class="text-xs leading-snug text-zinc-200">{finding.title}</p>
                <p class="text-[10px] text-zinc-500">
                  <span class="text-zinc-600">{dirName(finding.file)}</span>{fileName(finding.file)}
                  · {finding.lineRange[0]}–{finding.lineRange[1]}
                </p>
              </div>
              <span class="mt-0.5 flex-none text-[10px] text-zinc-600">
                {expandedIds.has(finding.id) ? '▲' : '▼'}
              </span>
            </button>
          </div>

          <!-- Expanded body -->
          {#if expandedIds.has(finding.id)}
            <div class="border-t border-zinc-800/60 px-3 py-2 pl-8">
              <p class="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">{finding.body}</p>
              <div class="mt-2 flex gap-1.5">
                <button
                  class="rounded bg-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-600"
                  onclick={(e) => handleDiscuss(finding, e)}
                >
                  Discuss
                </button>
                <button
                  class="ml-auto rounded px-2 py-1 text-[10px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-400"
                  onclick={() => reviewStore.dismiss(key, finding.id)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/each}

      <!-- Dismissed section -->
      {#if gone.length > 0}
        <div class="mt-1 border-t border-zinc-800">
          <button
            class="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[10px] text-zinc-600 hover:text-zinc-500"
            onclick={() => (showDismissed = !showDismissed)}
          >
            <span>{showDismissed ? '▼' : '▶'}</span>
            <span>Dismissed ({gone.length})</span>
          </button>
          {#if showDismissed}
            {#each gone as finding (finding.id)}
              <div class="flex items-start gap-2 border-t border-zinc-800/40 px-2 py-1.5 opacity-40">
                <span class="rounded border px-1 py-0.5 font-mono text-[10px] {LABEL_COLORS[finding.label]}">
                  {finding.label}
                </span>
                <p class="min-w-0 flex-1 truncate text-xs text-zinc-400">{finding.title}</p>
                <button
                  class="flex-none text-[10px] text-zinc-600 hover:text-zinc-400"
                  onclick={() => reviewStore.undismiss(key, finding.id)}
                >↩</button>
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    {/if}
  </div>

  <!-- Bulk action toolbar — visible when anything is selected -->
  {#if selectedIds.size > 0}
    {@const selectedFindings = (state?.findings ?? []).filter(
      (f) => selectedIds.has(f.id) && !(state?.dismissed.has(f.id))
    )}
    <div class="flex-none border-t border-zinc-700 bg-zinc-900">
      {#if !showSendForm}
        <!-- Compact toolbar -->
        <div class="flex items-center gap-2 px-2 py-1.5">
          <span class="text-[10px] text-zinc-500">{selectedIds.size} selected</span>
          <div class="ml-auto flex gap-1.5">
            <button
              class="rounded px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              onclick={dismissSelected}
            >
              Dismiss
            </button>
            <button
              class="rounded bg-orange-700/80 px-2 py-1 text-[10px] text-orange-200 hover:bg-orange-600"
              onclick={() => (showSendForm = true)}
            >
              Forward to Agent →
            </button>
          </div>
        </div>
      {:else}
        <!-- Expanded send form -->
        <div class="flex flex-col gap-2 p-2">
          <div class="flex items-center justify-between">
            <span class="text-[10px] font-medium text-zinc-400">
              Forward {selectedFindings.length} finding{selectedFindings.length !== 1 ? 's' : ''} to agent
            </span>
            <button
              class="text-[10px] text-zinc-600 hover:text-zinc-400"
              onclick={() => (showSendForm = false)}
            >✕</button>
          </div>

          <!-- Preview of selected findings -->
          <div class="max-h-20 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 px-2 py-1">
            {#each selectedFindings as f (f.id)}
              <p class="truncate text-[10px] text-zinc-500">
                <span class="text-zinc-400">{f.label}</span>
                · <span class="text-zinc-600">{fileName(f.file)}</span>
                · {f.title}
              </p>
            {/each}
          </div>

          <!-- Instruction textarea -->
          <textarea
            bind:value={agentInstruction}
            class="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
            rows="2"
            placeholder="Your instruction to the agent…"
          ></textarea>

          <!-- Terminal selector + send -->
          <div class="flex items-center gap-2">
            <select
              bind:value={selectedTerminalId}
              class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-blue-500"
            >
              {#each terminals as t (t.id)}
                <option value={t.id}>✦ {t.label}</option>
              {/each}
              <option value="new">✦ New Agent</option>
            </select>
            <button
              class="rounded bg-orange-600 px-3 py-1 text-xs text-white hover:bg-orange-500 disabled:opacity-40"
              disabled={selectedFindings.length === 0}
              onclick={() => sendToAgent(selectedFindings)}
            >
              Send
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
