<script lang="ts">
  import { memoryIssueSeverity, type MemoryHealthReportIssue } from '../../../shared/memory-health'
  import { memoryViewStore } from '../../stores/memoryView.svelte'

  interface Props {
    /** Session whose editor opens the clicked issue. */
    sessionId: string
    memoryDir: string
    /** Called after an issue was clicked (e.g. to close a popover). */
    onselect?: () => void
  }

  let { sessionId, memoryDir, onselect }: Props = $props()

  let health = $derived(memoryViewStore.health(memoryDir))
  let report = $derived(health?.report ?? null)

  function select(issue: MemoryHealthReportIssue): void {
    memoryViewStore.revealIssue(sessionId, issue)
    onselect?.()
  }
</script>

<div class="flex flex-col gap-1" data-testid="memory-health-list">
  {#if health?.error}
    <p class="px-2 text-xs text-red-400">{health.error}</p>
  {:else if !report}
    <p class="px-2 text-xs text-zinc-500">{health?.loading ? 'Checking memory…' : 'No memory files'}</p>
  {:else}
    <p class="px-2 text-[10px] text-zinc-500">
      {report.fileCount} {report.fileCount === 1 ? 'file' : 'files'} ·
      {report.issues.length === 0
        ? 'no issues'
        : `${report.issues.length} ${report.issues.length === 1 ? 'issue' : 'issues'}`}
    </p>
    {#if !report.indexPresent}
      <p class="px-2 text-[10px] text-zinc-500">No MEMORY.md index — unindexed files aren't checked.</p>
    {/if}
    {#if report.issues.length > 0}
      <ul class="flex flex-col gap-0.5" aria-label="Memory issues">
        {#each report.issues as issue (`${issue.rel}:${issue.line}:${issue.column}:${issue.kind}`)}
          {@const warning = memoryIssueSeverity(issue.kind) === 'warning'}
          <li>
            <button
              class="flex w-full items-start gap-2 rounded px-2 py-1 text-left text-zinc-300 hover:bg-zinc-800"
              onclick={() => select(issue)}
              title="Open {issue.rel} at line {issue.line}"
            >
              <span
                class="mt-1 h-2 w-2 shrink-0 rounded-full {warning ? 'bg-amber-400' : 'bg-sky-400'}"
                aria-label={warning ? 'Warning' : 'Info'}
              ></span>
              <span class="flex min-w-0 flex-col">
                <span class="truncate text-xs">{issue.message}</span>
                <span class="truncate font-mono text-[10px] text-zinc-500">{issue.rel}:{issue.line}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
