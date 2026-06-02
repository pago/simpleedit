<script lang="ts">
  import { untrack } from 'svelte'
  import CompactDiffEditor from './CompactDiffEditor.svelte'
  import { tourStore, tourKey, triggerTour, loadCachedTour } from '../../stores/tourStore.svelte'

  interface Props {
    worktreePath: string
    commitHash: string | null
    commitMessage: string
  }

  let { worktreePath, commitHash, commitMessage }: Props = $props()

  const isStaging = $derived(commitHash === null)
  const isBranch = $derived(commitHash === 'branch')
  const key = $derived(tourKey(worktreePath, commitHash))
  const tourState = $derived(tourStore.get(key))

  // File content cache for compact diff editors: file -> { original, modified }
  let fileContents = $state<Map<string, { original: string; modified: string }>>(new Map())

  // Track which segments have their diff expanded
  let expandedSegments = $state<Set<string>>(new Set())

  // Subscribe to tour IPC events
  $effect(() => {
    const currentKey = key
    const unsubOverview = window.api.on('tour:overview', (data) => {
      if (data.key === currentKey) tourStore.setOverview(currentKey, data.overview)
    })
    const unsubTopic = window.api.on('tour:topic', (data) => {
      if (data.key === currentKey) tourStore.addTopic(currentKey, data.topic)
    })
    const unsubStatus = window.api.on('tour:status', (data) => {
      if (data.key === currentKey) tourStore.setStatus(currentKey, data.status, data.error)
    })
    return () => { unsubOverview(); unsubTopic(); unsubStatus() }
  })

  // Attempt to load cached tour on mount
  $effect(() => {
    const currentKey = key
    const state = tourStore.get(currentKey)
    if (!state || state.status === 'idle') {
      void loadCachedTour(worktreePath, commitHash)
    }
  })

  // Backfill code snippets for every topic in the current tour, regardless of
  // how it arrived (#119). Streaming tours add topics over IPC; cached and
  // MCP-delivered (`tour:from-claude`) tours land in the store fully-formed —
  // this single path gives all three the same collapsible diffs. The load
  // itself is untracked so reading `fileContents` inside it doesn't re-trigger
  // this effect; it re-runs only when the tour's topics change.
  $effect(() => {
    const state = tourStore.get(key)
    if (!state) return
    const topics = state.topics
    untrack(() => {
      for (const topic of topics) void loadFileContentsForTopic(topic)
    })
  })

  async function loadFileContentsForTopic(topic: { segments: Array<{ file: string }> }): Promise<void> {
    const filesToLoad = new Set<string>()
    for (const seg of topic.segments) {
      if (!fileContents.has(seg.file)) filesToLoad.add(seg.file)
    }

    for (const file of filesToLoad) {
      try {
        let original: string
        let modified: string
        if (isBranch) {
          original = await window.api.invoke('git:file-at-branch-base', worktreePath, file).catch(() => '')
          modified = await window.api.invoke('fs:read', `${worktreePath}/${file}`).catch(() => '')
        } else if (isStaging) {
          original = await window.api.invoke('git:file-at-head', worktreePath, file)
          modified = await window.api.invoke('fs:read', `${worktreePath}/${file}`)
        } else {
          original = await window.api.invoke(
            'git:file-at-commit', worktreePath, `${commitHash}~1`, file
          ).catch(() => '')
          modified = await window.api.invoke(
            'git:file-at-commit', worktreePath, commitHash!, file
          ).catch(() => '')
        }
        const next = new Map(fileContents)
        next.set(file, { original, modified })
        fileContents = next
      } catch {
        // File might not exist in one side — skip
      }
    }
  }

  function segmentId(topicId: string, index: number): string {
    return `${topicId}:${index}`
  }

  function toggleSegmentDiff(id: string): void {
    const next = new Set(expandedSegments)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    expandedSegments = next
  }

  function handleStartTour(): void {
    expandedSegments = new Set()
    fileContents = new Map()
    const override = isStaging ? tourState?.editedOverview : undefined
    triggerTour(worktreePath, commitHash, override)
  }

  function handleRegenerate(): void {
    expandedSegments = new Set()
    fileContents = new Map()
    triggerTour(worktreePath, commitHash, tourState?.editedOverview ?? tourState?.overview)
  }

  function handleCopyAsCommitMessage(): void {
    const text = tourState?.editedOverview ?? tourState?.overview ?? ''
    navigator.clipboard.writeText(text)
  }

  function handleOverviewInput(e: Event): void {
    const target = e.target as HTMLTextAreaElement
    tourStore.setEditedOverview(key, target.value)
  }

  function dirName(path: string): string {
    const parts = path.split('/')
    if (parts.length <= 1) return ''
    return parts.slice(0, -1).join('/') + '/'
  }

  function fileName(path: string): string {
    const parts = path.split('/')
    return parts[parts.length - 1] ?? path
  }
</script>

<div class="flex h-full flex-col overflow-y-auto bg-zinc-950 px-6 py-4">
  <!-- Status bar -->
  {#if tourState?.status === 'running'}
    <div class="mb-4 flex items-center gap-2 text-xs text-zinc-500">
      <span class="animate-spin">⠿</span>
      <span>
        Generating tour…
        {#if tourState.topics.length > 0}
          {tourState.topics.length} topic{tourState.topics.length === 1 ? '' : 's'} so far
        {/if}
      </span>
    </div>
  {:else if tourState?.status === 'error'}
    <div class="mb-4 rounded bg-red-900/30 px-3 py-2 text-xs text-red-300">
      Tour generation failed{tourState.error ? `: ${tourState.error}` : ''}
    </div>
  {/if}

  <!-- Open-questions attention banner -->
  {#if tourState && tourState.openQuestions && tourState.openQuestions.length > 0}
    <a
      href="#tour-open-questions"
      class="mb-4 flex items-center gap-2 rounded border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200 no-underline hover:bg-amber-950/60"
    >
      <span aria-hidden="true">⚠</span>
      <span class="font-medium">Your input needed</span>
      <span class="text-amber-300/80">
        — {tourState.openQuestions.length} open question{tourState.openQuestions.length === 1 ? '' : 's'} below
      </span>
    </a>
  {/if}

  <!-- No tour yet: prompt to start -->
  {#if !tourState || (tourState.status === 'idle' && tourState.topics.length === 0)}
    <div class="flex flex-1 flex-col items-center justify-center gap-3">
      <p class="text-sm text-zinc-500">No tour generated yet</p>
      <button
        class="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
        onclick={handleStartTour}
      >
        ✦ Generate Tour
      </button>
    </div>
  {:else}
    <!-- Overview -->
    {#if tourState.overview || tourState.status === 'running'}
      <div class="mb-6">
        <h2 class="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">Overview</h2>
        {#if isStaging || isBranch}
          <textarea
            class="w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            rows="3"
            value={tourState.editedOverview ?? tourState.overview}
            oninput={handleOverviewInput}
            disabled={tourState.status === 'running' && !tourState.overview}
            placeholder="Tour overview will appear here…"
          ></textarea>
          <div class="mt-2 flex gap-2">
            <button
              class="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300"
              onclick={handleRegenerate}
              disabled={tourState.status === 'running'}
            >
              Re-generate
            </button>
            <button
              class="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300"
              onclick={handleCopyAsCommitMessage}
            >
              {isBranch ? 'Copy as PR description' : 'Copy as commit message'}
            </button>
          </div>
        {:else}
          <p class="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{tourState.overview}</p>
        {/if}
      </div>
    {/if}

    <!-- Topics -->
    {#each tourState.topics as topic (topic.id)}
      <div class="mb-6 border-t border-zinc-800 pt-4">
        <h3 class="mb-1 text-sm font-medium text-zinc-200">{topic.title}</h3>
        <p class="mb-3 whitespace-pre-wrap text-xs leading-relaxed text-zinc-400">{topic.summary}</p>

        {#each topic.segments as segment, segIdx (segmentId(topic.id, segIdx))}
          {@const sid = segmentId(topic.id, segIdx)}
          {@const contents = fileContents.get(segment.file)}
          {@const isExpanded = expandedSegments.has(sid)}

          <div class="mb-3 ml-2 border-l-2 border-zinc-800 pl-3">
            <p class="mb-1 whitespace-pre-wrap text-xs leading-relaxed text-zinc-400">{segment.prose}</p>

            <div class="mb-1 flex items-center gap-2">
              <span class="text-[10px] text-zinc-600">
                <span class="text-zinc-600">{dirName(segment.file)}</span><span class="text-zinc-500">{fileName(segment.file)}</span>
                <span class="ml-1 text-zinc-700">L{segment.lineRange[0]}–{segment.lineRange[1]}</span>
              </span>
              {#if contents}
                <button
                  class="text-[10px] text-zinc-600 hover:text-zinc-400"
                  onclick={() => toggleSegmentDiff(sid)}
                >
                  {isExpanded ? 'Hide diff' : 'Show diff'}
                </button>
              {/if}
            </div>

            {#if isExpanded && contents}
              <div class="mt-1">
                <CompactDiffEditor
                  originalContent={contents.original}
                  modifiedContent={contents.modified}
                  filePath={segment.file}
                  lineRange={segment.lineRange}
                />
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/each}

    <!-- Open questions list (below the tour) -->
    {#if tourState.openQuestions && tourState.openQuestions.length > 0}
      <div id="tour-open-questions" class="mt-2 border-t border-amber-800/40 pt-4">
        <h3 class="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-amber-300">
          <span aria-hidden="true">⚠</span>
          Open questions
        </h3>
        <ul class="space-y-2">
          {#each tourState.openQuestions as q}
            <li class="flex gap-2 rounded border border-amber-800/30 bg-amber-950/20 px-3 py-2 text-sm text-amber-100">
              <span class="text-amber-500" aria-hidden="true">•</span>
              <span class="whitespace-pre-wrap">{q}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

  {/if}
</div>
