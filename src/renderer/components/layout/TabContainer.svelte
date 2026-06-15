<script lang="ts">
  import CodeEditor from '../editor/CodeEditor.svelte'
  import DiffReview from '../editor/DiffReview.svelte'
  import TourPanel from '../editor/TourPanel.svelte'
  import ComposedPanel from '../composed/ComposedPanel.svelte'
  import type { Tab } from '../../stores/tabsStore.svelte'
  import type { AgentContext } from '../../lib/agent-message'
  import type { AgentTabInfo } from '../../stores/agentTerminals.svelte'

  interface Props {
    tab: Tab
    /** tabsStore key — the owning session's id. */
    workspaceKey: string
    /** The session's currently selected worktree; fallback git context for
     * tab kinds that don't carry their own (files, composed panels). */
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
    workspaceKey,
    worktreePath,
    terminals,
    onclose,
    onFileModified,
    ondiscusswithagent,
    onsendtoagent,
    onOpenFile,
  }: Props = $props()

  /** Diff/tour tabs pin their git context at open time. */
  let tabWorktree = $derived('worktreePath' in tab ? tab.worktreePath : worktreePath)
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
    {workspaceKey}
    worktreePath={tabWorktree}
    {terminals}
    {onclose}
    {ondiscusswithagent}
    {onsendtoagent}
  />
{:else if tab.kind === 'tour'}
  <TourPanel
    worktreePath={tabWorktree}
    commitHash={tab.commitHash}
    commitMessage={tab.commitMessage}
  />
{:else if tab.kind === 'composed'}
  <ComposedPanel
    spec={tab.spec}
    terminalId={tab.terminalId}
    {workspaceKey}
    {worktreePath}
    {onclose}
  />
{:else}
  {@const _exhaustive: never = tab}
{/if}
