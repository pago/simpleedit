<script lang="ts">
  import CodeEditor from '../editor/CodeEditor.svelte'
  import DiffReview from '../editor/DiffReview.svelte'
  import PlanView from '../editor/PlanView.svelte'
  import TourPanel from '../editor/TourPanel.svelte'
  import ComposedPanel from '../composed/ComposedPanel.svelte'
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
    onOpenFile?: (path: string) => void
  }

  let {
    tab,
    worktreePath,
    terminals,
    onclose,
    onFileModified,
    ondiscusswithagent,
    onsendtoagent,
    onOpenFile,
  }: Props = $props()
</script>

{#if tab.kind === 'file'}
  <div class="flex-1 min-h-0">
    <CodeEditor
      filePath={tab.path}
      worktreeRoot={worktreePath}
      onModified={onFileModified}
      {ondiscusswithagent}
      {onOpenFile}
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
  <TourPanel
    {worktreePath}
    commitHash={tab.commitHash}
    commitMessage={tab.commitMessage}
  />
{:else if tab.kind === 'composed'}
  <ComposedPanel
    spec={tab.spec}
    terminalId={tab.terminalId}
    {worktreePath}
    {onclose}
  />
{:else}
  {@const _exhaustive: never = tab}
{/if}
