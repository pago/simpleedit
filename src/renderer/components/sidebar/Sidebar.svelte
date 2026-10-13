<script lang="ts">
  import SessionList from './SessionList.svelte'
  import SidebarSection from './SidebarSection.svelte'
  import NewSessionButtons from './NewSessionButtons.svelte'
  import StatusDot from './StatusDot.svelte'
  import BacklogList from '../backlog/BacklogList.svelte'
  import ScreenPrsQueue from '../screenprs/ScreenPrsQueue.svelte'
  import SectionIcon from './SectionIcon.svelte'
  import { uiView } from '../../stores/uiView.svelte'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { backlogStore } from '../../stores/backlog.svelte'
  import { currentSessionsAttention } from '../../stores/sessionAttention.svelte'
  import { attentionTooltip } from '../../lib/sessionsAttention'

  let view = $derived(uiView.current())
  let sessionsAttention = $derived(currentSessionsAttention())
  let attention = $derived(screenPrsStore.attentionCount())
  let backlogCount = $derived(backlogStore.items.length)
</script>

<!-- An accordion over `uiView`: the open section is the view filling the main
     area, so the sidebar and the main area can't disagree. -->
<div class="flex h-full flex-col">
  <SidebarSection label="Sessions" expanded={view === 'workspace'} onexpand={() => uiView.show('workspace')}>
    {#snippet icon()}
      <SectionIcon view="workspace" />
    {/snippet}
    {#snippet indicator()}
      <span class="relative flex h-2 w-2 flex-none" title={attentionTooltip(sessionsAttention.counts)} data-testid="sessions-attention">
        <StatusDot level={sessionsAttention.level} />
      </span>
    {/snippet}
    {#snippet actions()}
      <NewSessionButtons />
    {/snippet}
    <div class="px-3 py-2">
      <SessionList />
    </div>
  </SidebarSection>

  <SidebarSection label="Backlog" expanded={view === 'backlog'} onexpand={() => uiView.show('backlog')}>
    {#snippet icon()}
      <SectionIcon view="backlog" />
    {/snippet}
    {#snippet indicator()}
      {#if backlogCount > 0}
        <span class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-zinc-700 px-1.5 text-[10px] font-bold tabular-nums text-zinc-200">{backlogCount}</span>
      {/if}
    {/snippet}
    <BacklogList class="min-h-full" />
  </SidebarSection>

  <SidebarSection label="Screen PRs" expanded={view === 'screenprs'} onexpand={() => uiView.show('screenprs')}>
    {#snippet icon()}
      <SectionIcon view="screenprs" />
    {/snippet}
    {#snippet indicator()}
      {#if attention > 0}
        <span class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold tabular-nums text-white">{attention}</span>
      {/if}
    {/snippet}
    <ScreenPrsQueue class="min-h-full" />
  </SidebarSection>
</div>
