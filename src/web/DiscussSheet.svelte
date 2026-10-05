<script lang="ts" module>
  const MODEL_KEY = 'simpleedit.discussModel'

  function rememberedModel(): string | null {
    try {
      return localStorage.getItem(MODEL_KEY)
    } catch {
      return null
    }
  }
  function rememberModel(id: string): void {
    try {
      localStorage.setItem(MODEL_KEY, id)
    } catch {
      // Private mode or blocked storage: the pick just isn't remembered.
    }
  }
</script>

<script lang="ts">
  /**
   * Discuss with Agent, from the phone: pick the agent and model, then start a
   * review session seeded with the same brief the desk sends (`buildPrBrief`).
   *
   * The brief is built when Start is tapped, not when the sheet opens, so a
   * deep review or overview that lands while the sheet is up is in it.
   *
   * Starting has the same exactly-once contract as the `+` sheet
   * (`NewSessionSheet`): one `requestId` per intent, reused by every retry, and
   * a deliberate "start another anyway" once main says the outcome is unknown.
   */
  import { onMount } from 'svelte'
  import { loadAgentModels, type AgentModel } from '../renderer/lib/agentModels'
  import { SESSION_CREATE_UNWITNESSED, type SessionCreateRequest, type SessionCreateResult } from '../shared/ipc-types'

  interface Props {
    /** `repo#number`, so the sheet says which PR it is about. */
    prLabel: string
    /** Fixed name of the new session. */
    label: string
    /** A Look-into question the session starts from. */
    focus?: string
    connected: boolean
    brief: () => string
    oncreated: (created: SessionCreateResult) => void
    onclose: () => void
  }

  let { prLabel, label, focus, connected, brief, oncreated, onclose }: Props = $props()

  let models = $state<AgentModel[]>([])
  let loadError = $state<string | null>(null)
  let selectedId = $state<string | null>(null)
  let starting = $state(false)
  let error = $state<string | null>(null)
  /** Main may hold an outcome nobody saw, so a retry returns the same answer. */
  let unwitnessed = $state(false)
  /**
   * The intent: minted at the first Start and resent unchanged by every retry,
   * brief included — main refuses an id that comes back with a different
   * request, and a deep review landing mid-retry would otherwise change it.
   */
  let intent: SessionCreateRequest | null = null

  const selected = $derived(models.find((m) => m.id === selectedId) ?? null)
  const cloud = $derived(models.filter((m) => m.tier === 'cloud'))
  const local = $derived(models.filter((m) => m.tier === 'local'))

  onMount(() => {
    loadAgentModels()
      .then((list) => {
        models = list
        const remembered = rememberedModel()
        // The desk's default for this button: Sonnet, else the first cloud model.
        selectedId =
          list.find((m) => m.id === remembered)?.id ??
          list.find((m) => m.id === 'anthropic:sonnet')?.id ??
          list.find((m) => m.tier === 'cloud')?.id ??
          list[0]?.id ??
          null
      })
      .catch((err: unknown) => {
        loadError = err instanceof Error ? err.message : String(err)
      })
  })

  function mintRequestId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }

  function pick(id: string): void {
    if (id !== selectedId) intent = null
    selectedId = id
    rememberModel(id)
  }

  async function attempt(): Promise<void> {
    const m = selected
    if (!m) return
    intent ??= { requestId: mintRequestId(), brief: brief(), target: $state.snapshot(m.target), label }
    starting = true
    error = null
    try {
      const created = await window.api.invoke('session:create', intent)
      intent = null
      unwitnessed = false
      oncreated(created)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      unwitnessed = err instanceof Error && err.message === SESSION_CREATE_UNWITNESSED
      throw err
    } finally {
      starting = false
    }
  }

  function start(): void {
    if (starting || !connected) return
    attempt().catch(() => {})
  }

  /**
   * Re-ask the same intent first: if the session did start and only its answer
   * was lost, main hands it back and there is one agent, not two. Only a second
   * unknown makes a fresh intent the user's choice.
   */
  async function startAnyway(): Promise<void> {
    if (starting || !connected) return
    try {
      await attempt()
      return
    } catch {
      if (!unwitnessed) return
    }
    intent = null
    attempt().catch(() => {})
  }

  /** A start in flight can't be cancelled from here, so Back waits for it. */
  export function holdForDraft(): boolean {
    return starting
  }

  function requestClose(): void {
    if (!starting) onclose()
  }
</script>

<div
  role="dialog"
  aria-modal="true"
  aria-label="Discuss with Agent"
  tabindex="-1"
  class="fixed inset-0 z-40 flex flex-col justify-end"
  data-testid="discuss-sheet"
>
  <button type="button" aria-label="Dismiss" onclick={requestClose} class="flex-1 bg-black/60" data-testid="discuss-scrim"></button>

  <div
    class="flex max-h-[80vh] flex-none flex-col rounded-t-2xl border-t border-zinc-800 bg-zinc-950 px-3 pt-3
           pb-[max(0.75rem,env(safe-area-inset-bottom))]"
  >
    <div class="mb-2 flex flex-none items-center gap-2">
      <h2 class="min-w-0 flex-1 truncate text-[15px] font-semibold text-zinc-100">✦ Discuss {prLabel}</h2>
      <button
        type="button"
        onclick={requestClose}
        disabled={starting}
        data-testid="discuss-close"
        class="-mr-1 min-h-9 px-2 text-sm text-zinc-400 disabled:opacity-40"
      >Cancel</button>
    </div>

    {#if focus}
      <p
        class="mb-2 flex-none rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-[12px] leading-relaxed text-zinc-300"
        data-testid="discuss-focus"
      >Starts from: {focus}</p>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto" role="radiogroup" aria-label="Model">
      {#if loadError}
        <p class="py-3 text-xs text-red-300" data-testid="discuss-models-error">Couldn’t list the models: {loadError}</p>
      {:else if models.length === 0}
        <p class="py-3 text-xs text-zinc-500">Loading models…</p>
      {/if}
      {#each [{ title: 'Cloud', list: cloud }, { title: 'Local', list: local }] as group (group.title)}
        {#if group.list.length}
          <h3 class="mb-1 mt-2 px-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{group.title}</h3>
          <ul class="space-y-1">
            {#each group.list as m (m.id)}
              <li>
                <button
                  type="button"
                  role="radio"
                  aria-checked={m.id === selectedId}
                  onclick={() => pick(m.id)}
                  disabled={starting || unwitnessed}
                  data-testid="discuss-model"
                  data-model={m.id}
                  class="flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 text-left text-[13px]
                    {m.id === selectedId ? 'border-blue-500 bg-blue-500/10 text-zinc-100' : 'border-zinc-800 bg-zinc-900 text-zinc-300'}"
                >
                  <span class="min-w-0 flex-1 truncate">{m.label}</span>
                  {#if m.id === selectedId}<span class="flex-none text-blue-300">✓</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {/each}
    </div>

    <div class="mt-3 flex-none">
      {#if error}
        <p class="mb-2 text-[11px] leading-relaxed text-red-300" data-testid="discuss-error">{error}</p>
      {/if}
      {#if !connected}
        <p class="mb-2 text-[11px] text-amber-400" data-testid="discuss-offline">Not connected. Start works once the dot goes green.</p>
      {/if}
      {#if unwitnessed && !starting}
        <button
          type="button"
          onclick={() => void startAnyway()}
          disabled={!connected}
          data-testid="discuss-start-anyway"
          class="mb-2 min-h-10 w-full rounded-lg border border-zinc-700 text-xs font-semibold text-zinc-200 active:bg-zinc-800 disabled:opacity-40"
        >Nothing in the list? Start a new session anyway</button>
      {/if}
      <button
        type="button"
        onclick={start}
        disabled={!selected || starting || !connected}
        data-testid="discuss-start"
        class="min-h-11 w-full rounded-lg bg-blue-600 text-sm font-semibold text-white active:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500"
      >{starting ? 'Starting…' : selected ? `Start with ${selected.label}` : 'Start'}</button>
    </div>
  </div>
</div>
