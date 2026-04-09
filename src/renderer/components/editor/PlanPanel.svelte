<script lang="ts">
  import { planStore, planKey, triggerPlanFromDescription, revisePlan, loadCachedPlan } from '../../stores/planStore.svelte'
  import type { PlanTask, PlanReaction, PlanDiscussionMessage } from '../../../shared/ipc-types'
  import type { AgentTabInfo } from '../../stores/agentTerminals.svelte'

  interface Props {
    worktreePath: string
    commitHash: string | null
    terminals: AgentTabInfo[]
    onsendtoagent?: (terminalId: string | 'new', message: string) => void
  }

  let { worktreePath, commitHash, terminals, onsendtoagent }: Props = $props()

  const key = $derived(planKey(worktreePath, commitHash))
  const planState = $derived(planStore.get(key))

  // Expanded task ids
  let expandedIds = $state(new Set<string>())

  // Discussion input per task
  let discussionInputs = $state<Map<string, string>>(new Map())

  // General revision input
  let revisionInput = $state('')

  // Subscribe to plan IPC events
  $effect(() => {
    const currentKey = key
    const unsubOverview = window.api.on('plan:overview', (data) => {
      if (data.key === currentKey) planStore.setOverview(currentKey, data.overview)
    })
    const unsubTask = window.api.on('plan:task', (data) => {
      if (data.key === currentKey) planStore.addTask(currentKey, data.task)
    })
    const unsubStatus = window.api.on('plan:status', (data) => {
      if (data.key === currentKey) planStore.setStatus(currentKey, data.status, data.error)
    })
    return () => { unsubOverview(); unsubTask(); unsubStatus() }
  })

  // Attempt to load cached plan on mount (also recover from error states)
  $effect(() => {
    const currentKey = key
    const state = planStore.get(currentKey)
    if (!state || state.status === 'idle' || (state.status === 'error' && state.tasks.length === 0)) {
      loadCachedPlan(worktreePath, commitHash)
    }
  })

  const REACTION_EMOJI: Record<PlanReaction, string> = {
    'thumbs-up': '\u{1F44D}',
    'thumbs-down': '\u{1F44E}',
    'question': '\u{2753}',
    'rocket': '\u{1F680}',
    'eyes': '\u{1F440}',
  }

  const REACTION_LABELS: Record<PlanReaction, string> = {
    'thumbs-up': 'Approve',
    'thumbs-down': 'Reject',
    'question': 'Need clarification',
    'rocket': 'Priority',
    'eyes': 'Reviewing',
  }

  const ALL_REACTIONS: PlanReaction[] = ['thumbs-up', 'thumbs-down', 'question', 'rocket', 'eyes']

  const STATUS_COLORS: Record<PlanTask['status'], string> = {
    'todo': 'text-zinc-400 bg-zinc-800 border-zinc-700',
    'in-progress': 'text-blue-400 bg-blue-950/50 border-blue-800/50',
    'done': 'text-green-400 bg-green-950/50 border-green-800/50',
    'rejected': 'text-red-400 bg-red-950/50 border-red-800/50',
  }

  const STATUS_LABELS: Record<PlanTask['status'], string> = {
    'todo': 'To Do',
    'in-progress': 'In Progress',
    'done': 'Done',
    'rejected': 'Rejected',
  }

  function toggleExpand(taskId: string): void {
    const next = new Set(expandedIds)
    if (next.has(taskId)) {
      next.delete(taskId)
    } else {
      next.add(taskId)
    }
    expandedIds = next
  }

  function toggleReaction(taskId: string, reaction: PlanReaction): void {
    const task = planState?.tasks.find((t) => t.id === taskId)
    if (!task) return

    if (task.reactions.includes(reaction)) {
      planStore.removeReaction(key, taskId, reaction)
    } else {
      planStore.addReaction(key, taskId, reaction)
    }

    // Shortcut behaviors
    if (reaction === 'thumbs-down' && !task.reactions.includes('thumbs-down')) {
      planStore.updateTaskStatus(key, taskId, 'rejected')
    }
    if (reaction === 'thumbs-up' && !task.reactions.includes('thumbs-up')) {
      if (task.status === 'rejected') {
        planStore.updateTaskStatus(key, taskId, 'todo')
      }
    }

    savePlanState()
  }

  function cycleStatus(taskId: string): void {
    const task = planState?.tasks.find((t) => t.id === taskId)
    if (!task) return
    const order: PlanTask['status'][] = ['todo', 'in-progress', 'done', 'rejected']
    const idx = order.indexOf(task.status)
    const next = order[(idx + 1) % order.length]
    planStore.updateTaskStatus(key, taskId, next)
    savePlanState()
  }

  function addDiscussionMessage(taskId: string): void {
    const text = discussionInputs.get(taskId)?.trim()
    if (!text) return

    const msg: PlanDiscussionMessage = {
      id: `${taskId}:msg:${Date.now()}`,
      taskId,
      role: 'user',
      text,
    }
    planStore.addDiscussionMessage(key, taskId, msg)

    const next = new Map(discussionInputs)
    next.set(taskId, '')
    discussionInputs = next

    savePlanState()

    // Auto-trigger revision with this feedback
    autoReviseFromFeedback()
  }

  function handleDiscussionKeydown(e: KeyboardEvent, taskId: string): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      addDiscussionMessage(taskId)
    }
  }

  function setDiscussionInput(taskId: string, value: string): void {
    const next = new Map(discussionInputs)
    next.set(taskId, value)
    discussionInputs = next
  }

  // Description input for empty state
  let planDescription = $state('')

  function handleStartPlan(): void {
    const text = planDescription.trim()
    if (!text) return
    expandedIds = new Set()
    triggerPlanFromDescription(worktreePath, text)
  }

  function handleDescriptionKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleStartPlan()
    }
  }

  function handleRevise(): void {
    const general = revisionInput.trim()
    const taskFeedback = collectFeedbackSummary()
    const parts: string[] = []
    if (general) parts.push(general)
    if (taskFeedback) parts.push('Per-task feedback:\n' + taskFeedback)
    if (parts.length === 0) return
    revisionInput = ''
    revisePlan(worktreePath, commitHash, parts.join('\n\n'))
  }

  function handleRevisionKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleRevise()
    }
  }

  function collectFeedbackSummary(): string {
    if (!planState) return ''
    const parts: string[] = []
    for (const task of planState.tasks) {
      const reactions = task.reactions.map((r) => REACTION_EMOJI[r]).join(' ')
      const msgs = task.discussion.map((m) => `  ${m.role}: ${m.text}`).join('\n')
      if (reactions || msgs) {
        parts.push(`Task: "${task.title}" [${task.status}]${reactions ? ` ${reactions}` : ''}`)
        if (msgs) parts.push(msgs)
      }
    }
    return parts.join('\n')
  }

  function autoReviseFromFeedback(): void {
    const feedback = collectFeedbackSummary()
    if (!feedback) return
    revisePlan(worktreePath, commitHash, feedback)
  }

  // ── Start task / Start all ──────────────────────────────

  function buildTaskMessage(task: PlanTask): string {
    const files = task.affectedFiles?.join(', ') ?? 'n/a'
    return `Please implement the following task:\n\n### ${task.title}\n${task.description}\n\nAffected files: ${files}`
  }

  function buildAllTasksMessage(tasks: PlanTask[]): string {
    const items = tasks.map((t, i) => {
      const files = t.affectedFiles?.join(', ') ?? 'n/a'
      return `### Task ${i + 1}: ${t.title}\n${t.description}\nAffected files: ${files}`
    })
    return ['Please implement the following plan:', ...items].join('\n\n')
  }

  function startTask(task: PlanTask): void {
    const message = buildTaskMessage(task)
    onsendtoagent?.('new', message)
    planStore.updateTaskStatus(key, task.id, 'in-progress')
    savePlanState()
  }

  function startAllTasks(): void {
    const todoTasks = activeTasks.filter((t) => t.status === 'todo')
    if (todoTasks.length === 0) return
    const message = buildAllTasksMessage(todoTasks)
    onsendtoagent?.('new', message)
    for (const t of todoTasks) {
      planStore.updateTaskStatus(key, t.id, 'in-progress')
    }
    savePlanState()
  }

  function savePlanState(): void {
    const plan = planStore.toPlan(key)
    if (plan) {
      window.api.invoke('plan:save', worktreePath, commitHash, plan)
    }
  }

  function fileName(path: string): string {
    return path.split('/').at(-1) ?? path
  }

  function dirName(path: string): string {
    const parts = path.split('/')
    return parts.length <= 1 ? '' : parts.slice(0, -1).join('/') + '/'
  }

  const activeTasks = $derived(planState?.tasks.filter((t) => t.status !== 'rejected') ?? [])
  const todoTasks = $derived(activeTasks.filter((t) => t.status === 'todo'))
  const rejectedTasks = $derived(planState?.tasks.filter((t) => t.status === 'rejected') ?? [])
  let showRejected = $state(false)

  const hasFeedback = $derived.by(() => {
    if (!planState) return false
    return planState.tasks.some((t) => t.reactions.length > 0 || t.discussion.length > 0)
  })
</script>

<div class="flex h-full flex-col overflow-hidden">
  <!-- Status bar -->
  {#if planState?.status === 'running' || planState?.status === 'revising'}
    <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
      <span class="animate-spin">⠿</span>
      <span>
        {planState.status === 'revising' ? 'Revising plan' : 'Generating plan'}…
        {#if planState.tasks.length > 0}
          {planState.tasks.length} task{planState.tasks.length === 1 ? '' : 's'} so far
        {/if}
      </span>
    </div>
  {:else if planState?.status === 'error'}
    <div class="border-b border-zinc-800 px-4 py-2 text-xs text-red-400">
      Plan failed{planState.error ? `: ${planState.error}` : ''}
    </div>
  {/if}

  <!-- Main content -->
  <div class="min-h-0 flex-1 overflow-y-auto bg-zinc-950 px-4 py-3">
    {#if !planState || (planState.status === 'idle' && planState.tasks.length === 0)}
      <!-- No plan yet — show description input -->
      <div class="flex flex-col gap-3 py-4">
        <label class="text-xs font-medium text-zinc-400">What would you like to plan?</label>
        <textarea
          bind:value={planDescription}
          class="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
          rows="3"
          placeholder="Describe what you want to build…"
          onkeydown={handleDescriptionKeydown}
        ></textarea>
        <button
          class="self-start rounded bg-purple-700/80 px-3 py-1.5 text-xs text-purple-200 hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-40"
          onclick={handleStartPlan}
          disabled={!planDescription.trim()}
        >
          ✦ Generate Plan
        </button>
      </div>
    {:else if (planState.status === 'running' || planState.status === 'revising') && planState.tasks.length === 0}
      <!-- Generating but no tasks yet -->
      <div class="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <p class="text-sm text-zinc-500">Claude is analyzing your codebase…</p>
        <p class="text-xs text-zinc-600">Tasks will appear here as they are planned</p>
      </div>
    {:else}
      <!-- Overview -->
      {#if planState.overview}
        <div class="mb-4">
          <h2 class="mb-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500">Plan Overview</h2>
          <p class="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{planState.overview}</p>
        </div>
      {/if}

      <!-- Task list -->
      {#if activeTasks.length > 0}
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Tasks ({activeTasks.length})
          </h2>
          <div class="flex gap-1.5">
            {#if todoTasks.length > 0 && planState.status === 'done'}
              <button
                class="rounded bg-orange-700/80 px-2 py-1 text-[10px] text-orange-200 hover:bg-orange-600"
                onclick={startAllTasks}
                title="Start all remaining tasks with a new Claude agent"
              >
                ✦ Start All ({todoTasks.length})
              </button>
            {/if}
          </div>
        </div>

        {#each activeTasks as task, idx (task.id)}
          <div class="mb-2 rounded border border-zinc-800 bg-zinc-900/50">
            <!-- Task header -->
            <div class="flex items-start gap-2 px-3 py-2">
              <!-- Task number + content -->
              <button
                class="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left hover:opacity-80"
                onclick={() => toggleExpand(task.id)}
              >
                <span class="mt-0.5 flex-none font-mono text-[10px] text-zinc-600">{idx + 1}.</span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span
                      class="cursor-pointer rounded border px-1 py-0.5 font-mono text-[10px] {STATUS_COLORS[task.status]}"
                      onclick={(e) => { e.stopPropagation(); cycleStatus(task.id) }}
                      title="Click to cycle status"
                      role="button"
                      tabindex="0"
                    >
                      {STATUS_LABELS[task.status]}
                    </span>
                    <span class="text-xs leading-snug text-zinc-200">{task.title}</span>
                  </div>
                  {#if task.affectedFiles && task.affectedFiles.length > 0}
                    <p class="mt-1 text-[10px] text-zinc-600">
                      {task.affectedFiles.map((f) => fileName(f)).join(', ')}
                    </p>
                  {/if}
                </div>
                <span class="mt-0.5 flex-none text-[10px] text-zinc-600">
                  {expandedIds.has(task.id) ? '▲' : '▼'}
                </span>
              </button>

            </div>

            <!-- Reaction bar + Start button -->
            <div class="flex items-center gap-1 border-t border-zinc-800/60 px-3 py-1.5">
              {#each ALL_REACTIONS as reaction (reaction)}
                {@const isActive = task.reactions.includes(reaction)}
                <button
                  class="rounded px-1.5 py-0.5 text-sm transition-all
                    {isActive
                      ? 'bg-zinc-700 ring-1 ring-zinc-600'
                      : 'opacity-40 hover:opacity-70'}"
                  onclick={() => toggleReaction(task.id, reaction)}
                  title={REACTION_LABELS[reaction]}
                >
                  {REACTION_EMOJI[reaction]}
                </button>
              {/each}
              <span class="flex-1"></span>
              {#if task.discussion.length > 0}
                <span class="text-[10px] text-zinc-600">
                  {task.discussion.length} msg{task.discussion.length !== 1 ? 's' : ''}
                </span>
              {/if}
              {#if task.status === 'todo'}
                <button
                  class="rounded bg-orange-700/80 px-2 py-0.5 text-[10px] text-orange-200 hover:bg-orange-600"
                  onclick={() => startTask(task)}
                  title="Start this task with a new Claude agent"
                >
                  Start
                </button>
              {/if}
            </div>

            <!-- Expanded detail -->
            {#if expandedIds.has(task.id)}
              <div class="border-t border-zinc-800/60 px-3 py-2">
                <!-- Description -->
                <p class="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">{task.description}</p>

                <!-- Affected files -->
                {#if task.affectedFiles && task.affectedFiles.length > 0}
                  <div class="mt-2">
                    <span class="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Files</span>
                    <div class="mt-1 flex flex-wrap gap-1">
                      {#each task.affectedFiles as file (file)}
                        <span class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                          <span class="text-zinc-600">{dirName(file)}</span>{fileName(file)}
                        </span>
                      {/each}
                    </div>
                  </div>
                {/if}

                <!-- Discussion thread -->
                <div class="mt-3">
                  <span class="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Feedback</span>
                  {#if task.discussion.length > 0}
                    <div class="mt-1 space-y-1.5">
                      {#each task.discussion as msg (msg.id)}
                        <div class="flex gap-2 text-xs">
                          <span class="flex-none font-medium {msg.role === 'user' ? 'text-blue-400' : 'text-green-400'}">
                            {msg.role === 'user' ? 'You' : 'Claude'}:
                          </span>
                          <span class="text-zinc-300">{msg.text}</span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                  <div class="mt-2 flex gap-1.5">
                    <input
                      type="text"
                      class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
                      placeholder="Adjust this task…"
                      value={discussionInputs.get(task.id) ?? ''}
                      oninput={(e) => setDiscussionInput(task.id, (e.target as HTMLInputElement).value)}
                      onkeydown={(e) => handleDiscussionKeydown(e, task.id)}
                    />
                    <button
                      class="rounded bg-purple-700/80 px-2 py-1 text-[10px] text-purple-200 hover:bg-purple-600"
                      onclick={() => addDiscussionMessage(task.id)}
                    >
                      ✦ Revise
                    </button>
                  </div>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      {/if}

      <!-- Rejected tasks -->
      {#if rejectedTasks.length > 0}
        <div class="mt-2 border-t border-zinc-800">
          <button
            class="flex w-full items-center gap-1.5 py-1.5 text-left text-[10px] text-zinc-600 hover:text-zinc-500"
            onclick={() => (showRejected = !showRejected)}
          >
            <span>{showRejected ? '▼' : '▶'}</span>
            <span>Rejected ({rejectedTasks.length})</span>
          </button>
          {#if showRejected}
            {#each rejectedTasks as task (task.id)}
              <div class="flex items-center gap-2 border-t border-zinc-800/40 px-2 py-1.5 opacity-40">
                <span class="rounded border px-1 py-0.5 font-mono text-[10px] {STATUS_COLORS['rejected']}">
                  Rejected
                </span>
                <p class="min-w-0 flex-1 truncate text-xs text-zinc-400">{task.title}</p>
                <button
                  class="flex-none text-[10px] text-zinc-600 hover:text-zinc-400"
                  onclick={() => { planStore.updateTaskStatus(key, task.id, 'todo'); planStore.removeReaction(key, task.id, 'thumbs-down'); savePlanState() }}
                  title="Restore task"
                >↩</button>
              </div>
            {/each}
          {/if}
        </div>
      {/if}

      <!-- General adjustments -->
      {#if activeTasks.length > 0}
        <div class="mt-3 border-t border-zinc-800 pt-3">
          <label class="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Adjustments
          </label>
          <div class="flex gap-1.5">
            <input
              type="text"
              bind:value={revisionInput}
              class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
              placeholder="e.g. Split task 2 into smaller pieces, add error handling…"
              onkeydown={handleRevisionKeydown}
            />
            <button
              class="rounded bg-purple-700/80 px-2 py-1 text-xs text-purple-200 hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-40"
              onclick={handleRevise}
              disabled={!revisionInput.trim() && !hasFeedback}
            >
              ✦ Revise Plan
            </button>
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>
