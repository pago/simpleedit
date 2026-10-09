<script lang="ts" module>
  import type { InteractiveTarget } from '../shared/ipc-types'

  /** The last pick as a `targetKey`: `''` is Default. */
  const MODEL_KEY = 'simpleedit.discussTarget'

  function rememberedTarget(): InteractiveTarget | null {
    try {
      const key = localStorage.getItem(MODEL_KEY)
      return key ? (JSON.parse(key) as InteractiveTarget) : null
    } catch {
      return null
    }
  }
  function rememberTarget(key: string): void {
    try {
      localStorage.setItem(MODEL_KEY, key)
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
  import { loadAllowlistedModels, refreshAllowlistedModelsOnFocus, targetKey, targetLabel, type AllowlistedModel } from '../renderer/lib/agentModels'
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

  let models = $state<AllowlistedModel[]>([])
  let loadError = $state<string | null>(null)
  /** null = Default. A remembered pick the allowlist no longer lists stays picked, and listed. */
  let target = $state<InteractiveTarget | null>(rememberedTarget())
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

  const selectedKey = $derived(targetKey(target))
  const selectedLabel = $derived(targetLabel(target, models))
  const entries = $derived([
    { key: '', label: 'Default', target: null },
    ...(target && !models.some((m) => targetKey(m.target) === selectedKey) ? [{ key: selectedKey, label: selectedLabel, target }] : []),
    ...models.map((m) => ({ key: targetKey(m.target), label: m.label, target: m.target })),
  ])

  // Settings → Models on the Mac has no change event: reread it each time the
  // sheet opens, and when the app comes back. The old list stays up meanwhile.
  function takeModels(load: Promise<AllowlistedModel[]> | null): void {
    load
      ?.then((list) => {
        models = list
        loadError = null
      })
      .catch((err: unknown) => {
        loadError = err instanceof Error ? err.message : String(err)
      })
  }
  const onWindowFocus = (): void => takeModels(refreshAllowlistedModelsOnFocus())

  onMount(() => {
    takeModels(loadAllowlistedModels())
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  })

  function mintRequestId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }

  function pick(key: string, next: InteractiveTarget | null): void {
    if (key !== selectedKey) intent = null
    target = next
    rememberTarget(key)
  }

  async function attempt(): Promise<void> {
    intent ??= { requestId: mintRequestId(), brief: brief(), ...(target ? { target: $state.snapshot(target) } : {}), label }
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
      {/if}
      <ul class="space-y-1">
        {#each entries as m (m.key)}
          <li>
            <button
              type="button"
              role="radio"
              aria-checked={m.key === selectedKey}
              onclick={() => pick(m.key, m.target)}
              disabled={starting || unwitnessed}
              data-testid="discuss-model"
              data-model={m.key}
              class="flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 text-left text-[13px]
                {m.key === selectedKey ? 'border-blue-500 bg-blue-500/10 text-zinc-100' : 'border-zinc-800 bg-zinc-900 text-zinc-300'}"
            >
              <span class="min-w-0 flex-1 truncate">{m.label}</span>
              {#if m.key === selectedKey}<span class="flex-none text-blue-300">✓</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
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
        disabled={starting || !connected}
        data-testid="discuss-start"
        class="min-h-11 w-full rounded-lg bg-blue-600 text-sm font-semibold text-white active:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500"
      >{starting ? 'Starting…' : `Start with ${selectedLabel}`}</button>
    </div>
  </div>
</div>
