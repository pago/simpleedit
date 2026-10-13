<script lang="ts">
  import ContextMenu, { type ContextMenuItem } from '../ContextMenu.svelte'
  import { sessionsStore, createSessionFromDefaults } from '../../stores/sessions.svelte'
  import type { AgentProviderId, InteractiveTarget, NativeModelAgentId } from '../../../shared/ipc-types'
  import { capabilitiesFor, knownProviders, providerLabel } from '../../stores/agent-capabilities.svelte'
  import { worktreeList, projectRoot, mainWorktree } from '../../stores/worktrees.svelte'
  import { uiView } from '../../stores/uiView.svelte'
  import { loadAllowlistedModels } from '../../lib/agentModels'

  /**
   * Agent sessions launch at the PROJECT ROOT (one agent memory for all work,
   * and agents create their own worktrees); the workspace viewer defaults to
   * the main worktree. See `Session.launchDir`.
   *
   * Every start here is the user's, so it brings the workspace forward. Sessions
   * that agents or the phone create go through the store and leave the view alone.
   */
  function launchSite(): { root: string; worktree: string } | null {
    const wt = mainWorktree()
    const root = projectRoot() ?? wt?.path
    if (!root || !wt) return null
    uiView.show('workspace')
    return { root, worktree: wt.path }
  }

  function startClaude(): void {
    const site = launchSite()
    if (site) sessionsStore.createClaude(site.root, site.worktree)
  }

  /** Start any provider that names its model by bare native id. */
  function startNative(provider: NativeModelAgentId, model?: string): void {
    const site = launchSite()
    if (site) sessionsStore.createNativeAgent(provider, site.root, site.worktree, model ? { model } : {})
  }

  /** The ✦ button, ⌘T and the phone's `+` all ask for the same session. */
  async function startLastTarget(): Promise<void> {
    const config = await window.api.invoke('models:config-get').catch(() => null)
    const site = launchSite()
    if (site) createSessionFromDefaults(config, site.root, site.worktree)
  }

  function startAgents(): void {
    const site = launchSite()
    if (site) sessionsStore.createAgents(site.root, site.worktree)
  }

  /** Terminals are working-tree tools — they launch in the main worktree. */
  function startTerminal(): void {
    const wt = mainWorktree()
    if (!wt) return
    uiView.show('workspace')
    sessionsStore.createTerminal(wt.path)
  }

  // ── new-session menu (✦ button: claude / agent view / allowlisted models) ──
  let newMenu: { x: number; y: number } | null = $state(null)
  let newButtonEl: HTMLButtonElement | undefined = $state()

  /**
   * One entry per registered provider, then the fixed entries. Built from the
   * capability descriptors so a provider that registers itself in main shows up
   * here without this component being edited.
   */
  function newMenuDefaults(): ContextMenuItem[] {
    const providers = knownProviders()
    const perProvider = (providers.length > 0 ? providers : (['claude'] as AgentProviderId[])).map((id) => ({
      id: `new-provider:${id}`,
      // The suffix says the session starts on the configured default model
      // rather than prompting for one. It applies to every provider that names
      // a model natively, not just the first one that happened to have it.
      label: capabilitiesFor(id)?.modelSelector === 'model-id'
        ? `New ${providerLabel(id)} session · configured default`
        : `New ${providerLabel(id)} session`,
    }))
    return [
      ...perProvider,
      { id: 'new-agents', label: 'New Agent View session' },
      { id: 'new-terminal', label: 'New terminal', separatorBefore: true },
    ]
  }

  /**
   * Model entries resolved from the catalogs — empty until `buildNewMenu`
   * finishes. Kept separate from the provider entries so the whole menu can be
   * DERIVED: capabilities and catalogs both arrive asynchronously, and a
   * snapshot taken at component init would show neither.
   */
  let modelMenuItems: ContextMenuItem[] = $state([])
  const newMenuItems: ContextMenuItem[] = $derived([...newMenuDefaults(), ...modelMenuItems])
  /** key (allowlist entry) → ModelRef for the current menu; rebuilt on open. */
  let modelMenuRefs: Map<string, InteractiveTarget> = $state(new Map())

  /**
   * The Settings → Models allowlist as "start a session with model X" entries
   * (`loadAllowlistedModels`); just the defaults if the catalogs can't be read.
   */
  async function buildNewMenu(): Promise<void> {
    try {
      const resolved = await loadAllowlistedModels()
      modelMenuRefs = new Map(resolved.map((m) => [m.key, m.target]))
      modelMenuItems = resolved.map((m, i) => ({
        id: `model:${m.key}`,
        label: `New session · ${m.label}`,
        separatorBefore: i === 0,
      }))
    } catch {
      modelMenuRefs = new Map()
      modelMenuItems = []
    }
  }

  function pickNewMenuItem(id: string): void {
    if (id.startsWith('new-provider:')) {
      const provider = id.slice('new-provider:'.length) as AgentProviderId
      if (provider === 'claude') startClaude()
      else startNative(provider as NativeModelAgentId)
    } else if (id === 'new-agents') {
      startAgents()
    } else if (id === 'new-terminal') {
      startTerminal()
    } else if (id.startsWith('model:')) {
      const target = modelMenuRefs.get(id.slice('model:'.length))
      if (!target) return
      const site = launchSite()
      if (site) sessionsStore.createAgent(target, site.root, site.worktree, {
        ...(target.provider === 'claude' && target.model ? { model: target.model } : {}),
      })
    }
  }

  function openNewMenuAtPointer(e: MouseEvent): void {
    e.preventDefault()
    // Open first, resolve the model submenu after. Every catalog behind
    // `buildNewMenu` shells out to a CLI (and OpenCode's may reach the network),
    // so awaiting it left the menu unopened for as long as the slowest one
    // took. `newMenuItems` is derived, so the model entries appear when they
    // arrive rather than gating the provider entries that are already known.
    // They append below the provider block, so an open menu grows downwards
    // rather than renumbering what the pointer is already over.
    const { clientX: x, clientY: y } = e
    newMenu = { x, y }
    void buildNewMenu()
  }
</script>

<div class="flex flex-none items-center gap-1">
  <button
    bind:this={newButtonEl}
    class="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-orange-400/70 hover:bg-zinc-700 hover:text-orange-300 disabled:opacity-50"
    onclick={() => void startLastTarget()}
    oncontextmenu={openNewMenuAtPointer}
    disabled={worktreeList().length === 0}
    aria-label="New agent session"
    aria-haspopup="menu"
    title="New agent session (⌘T · right-click to choose provider)"
  >
    ✦ Agent
  </button>
  <button
    class="flex h-5 items-center rounded px-1.5 text-[11px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-50"
    onclick={startTerminal}
    disabled={worktreeList().length === 0}
    title="New terminal"
  >
    + Term
  </button>
</div>

{#if newMenu}
  <ContextMenu
    x={newMenu.x}
    y={newMenu.y}
    items={newMenuItems}
    onpick={pickNewMenuItem}
    onclose={() => {
      newMenu = null
      newButtonEl?.focus()
    }}
  />
{/if}
