<script lang="ts">
  /**
   * Pick the Mac window — the project — this phone is attached to.
   *
   * Switching is a reconnect to the other window (see `lib/project.ts`), and
   * everything on the Sessions tab belongs to the window being left, so it
   * goes. That is why the sheet asks first when something there would be lost,
   * and refuses outright while something cannot be: a session still starting,
   * or Screen PRs work whose answer will arrive on the window being left.
   */
  import DiscardConfirm from './DiscardConfirm.svelte'
  import type { RemoteProject } from '../shared/ipc-types'

  interface Props {
    projects: RemoteProject[]
    /** The window this phone is attached to now. */
    currentWindowId: number | null
    connected: boolean
    /** Why switching cannot happen right now, or null when it can. */
    blocked: string | null
    /** What switching would throw away, to be confirmed first. */
    discards: string[]
    onpick: (project: RemoteProject) => void
    onclose: () => void
  }

  let { projects, currentWindowId, connected, blocked, discards, onpick, onclose }: Props = $props()

  let confirming = $state<RemoteProject | null>(null)

  /** Back with the confirm up dismisses the confirm, not the sheet. */
  export function holdForConfirm(): boolean {
    if (!confirming) return false
    confirming = null
    return true
  }

  function confirmSwitch(): void {
    const target = confirming
    confirming = null
    if (target) onpick(target)
  }

  /** Two windows on one repo are two projects with one name; the window id tells them apart. */
  const duplicated = $derived(
    new Set(projects.map((p) => p.name).filter((name, i, all) => all.indexOf(name) !== i)),
  )

  function pick(project: RemoteProject): void {
    if (project.windowId === currentWindowId) {
      onclose()
      return
    }
    if (blocked || !connected) return
    if (discards.length > 0) {
      confirming = project
      return
    }
    onpick(project)
  }
</script>

<div
  inert={confirming !== null}
  role="dialog"
  aria-modal="true"
  aria-label="Project"
  tabindex="-1"
  class="fixed inset-0 z-40 flex flex-col justify-end"
  data-testid="project-sheet"
>
  <button type="button" aria-label="Dismiss" onclick={onclose} class="flex-1 bg-black/60"></button>

  <div
    class="max-h-[70%] flex-none overflow-y-auto rounded-t-2xl border-t border-zinc-800 bg-zinc-950 px-3 pt-3
           pb-[max(0.75rem,env(safe-area-inset-bottom))]"
  >
    <div class="mb-2 flex items-center gap-2">
      <h2 class="min-w-0 flex-1 text-[15px] font-semibold text-zinc-100">Project</h2>
      <button
        type="button"
        onclick={onclose}
        data-testid="project-sheet-close"
        class="-mr-1 min-h-9 px-2 text-sm text-zinc-400"
      >Done</button>
    </div>

    <p class="mb-2 text-[11px] leading-relaxed text-zinc-500">
      The projects open in a window on the Mac. This phone shows one at a time and remembers your pick.
    </p>

    {#if blocked}
      <p class="mb-2 text-[11px] leading-relaxed text-amber-400" data-testid="project-blocked">{blocked}</p>
    {:else if !connected}
      <p class="mb-2 text-[11px] text-amber-400">Not connected. Switching works once the dot goes green.</p>
    {/if}

    {#if projects.length === 0}
      <p class="py-4 text-center text-xs text-zinc-500" data-testid="project-empty">
        No window on the Mac has a project open.
      </p>
    {:else}
      <ul class="flex flex-col gap-1">
        {#each projects as project (project.windowId)}
          {@const current = project.windowId === currentWindowId}
          <li>
            <button
              type="button"
              onclick={() => pick(project)}
              disabled={!current && (blocked !== null || !connected)}
              aria-current={current ? 'true' : undefined}
              data-testid="project-option"
              data-window-id={project.windowId}
              class="flex min-h-12 w-full items-center gap-2 rounded-lg border px-3 py-2 text-left disabled:opacity-40
                {current ? 'border-zinc-600 bg-zinc-900' : 'border-zinc-800 active:bg-zinc-900'}"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm text-zinc-100">
                  {project.name}{#if duplicated.has(project.name)}<span class="text-zinc-500"> · window {project.windowId}</span>{/if}
                </span>
                <span class="block truncate font-mono text-[10px] text-zinc-600">{project.repoPath}</span>
              </span>
              {#if current}
                <span class="flex-none text-[11px] text-emerald-400">Connected</span>
              {:else if project.focused}
                <span class="flex-none text-[11px] text-zinc-500">Focused on Mac</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

{#if confirming}
  <DiscardConfirm
    title="Switch to {confirming.name}?"
    body="Switching discards {discards.join(' and ')}. Sessions keep running on the Mac."
    testid="project-switch-confirm"
    onkeep={() => { confirming = null }}
    ondiscard={confirmSwitch}
  />
{/if}
