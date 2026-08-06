<script lang="ts">
  import { sessionsStore, type Session } from '../../stores/sessions.svelte'
  import { assembleBriefContext } from '../../lib/session-brief'
  import { capabilitiesFor, knownProviders, providerLabel } from '../../stores/agent-capabilities.svelte'
  import { REASONING_EFFORTS, type AgentProviderId, type InteractiveTarget, type ReasoningEffort } from '../../../shared/ipc-types'

  interface Props {
    session: Session
    onclose: () => void
  }

  let { session, onclose }: Props = $props()

  function initialProvider(): AgentProviderId {
    return session.provider ?? 'claude'
  }

  function initialReasoningEffort(): string {
    return session.target?.provider === 'codex' ? (session.target.reasoningEffort ?? '') : ''
  }

  /**
   * The model already on this session's target, as a plain id. Providers carry
   * it differently — a structured ModelRef, or a bare id — which is what
   * `capabilities.modelSelector` describes.
   */
  function initialModelId(): string {
    const t = session.target
    if (!t) return ''
    return t.provider === 'claude' ? (t.model?.model ?? '') : (t.model ?? '')
  }

  // The human writes the directive (what the successor should DO — the reason
  // for the reset); the composer prefills the supporting context. Net brief =
  // directive + context. See plans/session-spawn.md §3.
  let directive = $state('')
  let context = $state('Assembling context…')
  let directiveEl: HTMLTextAreaElement | undefined = $state()
  let provider = $state<AgentProviderId>(initialProvider())
  let modelId = $state(initialModelId())
  let reasoningEffort = $state(initialReasoningEffort())

  // Everything provider-specific below reads the descriptor, never the id — so
  // a new provider appears here by registering in main, not by editing this file.
  const caps = $derived(capabilitiesFor(provider))
  const providers = $derived(knownProviders().length > 0 ? knownProviders() : [provider])

  let canSubmit = $derived(directive.trim().length > 0)

  $effect(() => {
    directiveEl?.focus()
  })

  // Gather the context block once at mount for THIS session.
  $effect(() => {
    const s = session
    let cancelled = false
    void assembleBriefContext(s).then((c) => {
      if (!cancelled) context = c
    })
    return () => {
      cancelled = true
    }
  })

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onclose()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  }

  function submit(): void {
    if (!canSubmit) return
    const initialPrompt = `${directive.trim()}\n\n${context.trim()}`
    // 'replace': hand off in place — the successor takes this session's slot and
    // the current (fat) session is closed. That's the whole point of a hand-off.
    // `modelSelector` says how this provider carries a model: a structured
    // ModelRef, or the bare id it was typed as.
    const target: InteractiveTarget = caps?.modelSelector === 'model-id'
      ? {
          provider: 'codex',
          ...(modelId ? { model: modelId } : {}),
          ...(caps?.reasoningEffort && reasoningEffort
            ? { reasoningEffort: reasoningEffort as ReasoningEffort }
            : {}),
        }
      : {
          provider: 'claude',
          ...(modelId ? { model: { provider: 'anthropic' as const, model: modelId } } : {}),
        }
    sessionsStore.replaceWithAgent(session.id, target, session.launchDir, session.worktreePath, {
      initialPrompt,
      label: session.label,
      ...(target.provider === 'claude' && target.model ? { model: target.model } : {}),
    })
    onclose()
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onclick={onclose}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="flex max-h-[80vh] w-[560px] flex-col rounded-md border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
    onclick={(e) => e.stopPropagation()}
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-label="Hand off to a new session"
    tabindex="-1"
  >
    <h2 class="text-sm font-medium text-zinc-100">Hand off to a new session</h2>
    <p class="mt-1 text-xs text-zinc-500">
      Starts a fresh session on a clean context and closes “{session.label}”. Tell it what to do; the
      context below is prefilled — trim it, but don’t paste in file contents.
    </p>

    <label for="handoff-directive" class="mt-3 mb-1 block text-xs text-zinc-400">
      What should the new session do?
    </label>
    <textarea
      id="handoff-directive"
      bind:this={directiveEl}
      bind:value={directive}
      rows="3"
      placeholder="e.g. Rebase this PR onto main and get CI green."
      class="w-full resize-none rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-blue-500"
    ></textarea>

    <div class="mt-3 grid grid-cols-3 gap-2">
      <label class="text-xs text-zinc-400">Provider
        <select bind:value={provider} class="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200">
          {#each providers as id (id)}<option value={id}>{providerLabel(id)}</option>{/each}
        </select>
      </label>
      <label class="col-span-2 text-xs text-zinc-400">Model <span class="text-zinc-600">(default when blank)</span>
        <input bind:value={modelId} class="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200" />
      </label>
      {#if caps?.reasoningEffort}
        <label class="text-xs text-zinc-400">Reasoning
          <select bind:value={reasoningEffort} class="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200">
            <option value="">Model default</option>
            <!-- One list, shared with the launch flags and the spawn_session schema. -->
            {#each REASONING_EFFORTS as effort (effort)}<option value={effort}>{effort}</option>{/each}
          </select>
        </label>
      {/if}
    </div>

    <label for="handoff-context" class="mt-3 mb-1 block text-xs text-zinc-400">Context (editable)</label>
    <textarea
      id="handoff-context"
      bind:value={context}
      rows="12"
      class="min-h-0 flex-1 w-full resize-none overflow-auto rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-300 outline-none focus:border-blue-500"
    ></textarea>

    <div class="mt-4 flex items-center justify-end gap-2">
      <span class="mr-auto text-[10px] text-zinc-600">⌘↵ to hand off</span>
      <button
        class="rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
        onclick={onclose}
      >
        Cancel
      </button>
      <button
        class="rounded bg-blue-600 px-3 py-1 text-sm text-white enabled:hover:bg-blue-500 disabled:opacity-50"
        onclick={submit}
        disabled={!canSubmit}
      >
        Hand off
      </button>
    </div>
  </div>
</div>
