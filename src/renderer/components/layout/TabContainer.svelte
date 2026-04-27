<script lang="ts">
  import CodeEditor from '../editor/CodeEditor.svelte'
  import DiffReview from '../editor/DiffReview.svelte'
  import PlanView from '../editor/PlanView.svelte'
  import TourPanel from '../editor/TourPanel.svelte'
  import type { Tab } from '../../stores/tabsStore.svelte'
  import type { AgentContext } from '../../lib/agent-message'
  import type { AgentTabInfo } from '../../stores/agentTerminals.svelte'

  interface Props {
    tab: Tab
    worktreePath: string
    terminals: AgentTabInfo[]
    onclose: () => void
    onFileModified: (path: string, modified: boolean) => void
    ondiscusswithagent?: (ctx: AgentContext, pos: { x: number; y: number }) => void
    onsendtoagent?: (terminalId: string | 'new', message: string) => string | undefined
  }

  let {
    tab,
    worktreePath,
    terminals,
    onclose,
    onFileModified,
    ondiscusswithagent,
    onsendtoagent,
  }: Props = $props()
</script>

{#if tab.kind === 'file'}
  <div class="flex-1 min-h-0">
    <CodeEditor
      filePath={tab.path}
      worktreeRoot={worktreePath}
      onModified={onFileModified}
      {ondiscusswithagent}
    />
  </div>
{:else if tab.kind === 'diff'}
  <DiffReview
    commitHash={tab.commitHash}
    commitMessage={tab.commitMessage}
    initialTab={tab.initialTab}
    {worktreePath}
    {terminals}
    {onclose}
    {ondiscusswithagent}
    {onsendtoagent}
  />
{:else if tab.kind === 'plan'}
  <PlanView
    {worktreePath}
    commitHash={tab.planHash}
    {terminals}
    {onclose}
    {onsendtoagent}
  />
{:else if tab.kind === 'tour'}
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
      <button
        class="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
        onclick={onclose}
      >
        &larr; Close
      </button>
      <span class="text-xs font-medium text-zinc-300">Tour</span>
      <span class="truncate text-[10px] text-zinc-500">{tab.commitMessage}</span>
    </div>
    <div class="min-h-0 flex-1">
      <TourPanel
        {worktreePath}
        commitHash={tab.commitHash}
        commitMessage={tab.commitMessage}
      />
    </div>
  </div>
{:else if tab.kind === 'composed'}
  <!-- Reserved for the generative-UI follow-up. Renderer intentionally not wired in Phase 1. -->
  <div class="flex flex-1 items-center justify-center">
    <p class="text-sm text-zinc-600">Composed tabs are not yet implemented.</p>
  </div>
{:else}
  {@const _exhaustive: never = tab}
{/if}
