<script lang="ts">
  import { Renderer, JsonUIProvider } from '@json-render/svelte'
  import { registry } from './registry'
  import type { Spec } from '../../../shared/gen-ui-catalog'
  import { openDiffTab } from '../../stores/diffReview.svelte'
  import { tabsStore, tabIdFor, type FileTab } from '../../stores/tabsStore.svelte'
  import type { AgentContext } from '../../lib/agent-message'
  import { stampBlockIds, describeBlock } from './block-context'

  interface Props {
    spec: Spec
    /** Source terminal id, if any — used to route `send_to_agent` writes to
     * the originating Claude session and as the panel's identity for rate
     * limiting. Phase-2 always provides this; absent only in dev demos. */
    terminalId?: string
    /** tabsStore key of the owning session — where file/diff opens land. */
    workspaceKey: string
    /** The session's selected worktree. Used as git context for diff opens. */
    worktreePath: string
    onclose?: () => void
    /** Opens the "Discuss with Agent" popover for a selection inside a block. */
    ondiscusswithagent?: (ctx: AgentContext, pos: { x: number; y: number }) => void
  }

  let { spec, terminalId, workspaceKey, worktreePath, onclose, ondiscusswithagent }: Props = $props()

  // The renderer walks a copy of the spec whose elements carry their own key,
  // which is what gives each rendered block a DOM identity to select against.
  let renderSpec = $derived(stampBlockIds(spec))

  // -- send_to_agent rate limiting -------------------------------------------
  // Spec-driven feedback loops (an action button that writes back to the same
  // Claude that produced the spec) can run away fast. Cap dispatches per
  // terminal to a sane bound; further calls warn and no-op until the window
  // rolls forward.
  const SEND_RATE_WINDOW_MS = 60_000
  const SEND_RATE_MAX = 10
  let recentSends = $state<number[]>([])

  function tryRecordSend(): boolean {
    const now = Date.now()
    recentSends = recentSends.filter((t) => now - t < SEND_RATE_WINDOW_MS)
    if (recentSends.length >= SEND_RATE_MAX) return false
    recentSends = [...recentSends, now]
    return true
  }

  // -- Action handlers -------------------------------------------------------

  async function handleSendToAgent(params: Record<string, unknown>): Promise<void> {
    const text = typeof params['text'] === 'string' ? params['text'] : ''
    if (!terminalId) {
      console.warn('[gen-ui] send_to_agent dispatched on a panel without a terminalId; dropping.')
      return
    }
    if (!text) return
    if (!tryRecordSend()) {
      console.warn(
        `[gen-ui] send_to_agent rate limit hit (${SEND_RATE_MAX}/min) for terminal ${terminalId}; dropping.`,
      )
      return
    }
    await window.api.invoke('pty:write', terminalId, text + '\r')
  }

  /**
   * An action may name its own worktree (a tour can span repos); main validated
   * it against the window's registered worktrees before the panel opened.
   */
  function scopeOf(params: Record<string, unknown>): string {
    const named = typeof params['worktree'] === 'string' ? params['worktree'] : ''
    return named || worktreePath
  }

  async function handleOpenFile(params: Record<string, unknown>): Promise<void> {
    const raw = typeof params['path'] === 'string' ? params['path'] : ''
    if (!raw) return
    // Tabs are keyed by absolute path; the validator resolves a relative
    // `path` against its worktree, so resolve it the same way here.
    const scope = scopeOf(params).replace(/\/+$/, '')
    const path = raw.startsWith('/') ? raw : `${scope}/${raw}`
    const tab: FileTab = {
      kind: 'file',
      id: tabIdFor({ kind: 'file', path }),
      path,
      modified: false,
    }
    tabsStore.open(workspaceKey, tab)
  }

  async function handleShowDiff(params: Record<string, unknown>): Promise<void> {
    const commitHash = typeof params['commitHash'] === 'string' ? params['commitHash'] : ''
    if (!commitHash) return
    openDiffTab(workspaceKey, scopeOf(params), commitHash, `Commit ${commitHash.slice(0, 7)}`)
  }

  function handleDismiss(): void {
    onclose?.()
  }

  // set_state is handled by json-render's StateProvider directly via the
  // panel's local $bindState scope; we pass a no-op here as the host hook
  // because the framework already owns that path.
  function handleSetState(_params: Record<string, unknown>): void {
    /* json-render owns state mutation through the provider context. */
  }

  // -- "Discuss this" on a selection ----------------------------------------
  // Selecting text anywhere in the panel — prose, code, a diff row — offers a
  // pill that hands the block (id, type, content) plus the selection to the
  // agent popover.
  let panelEl = $state<HTMLElement | null>(null)
  let pill = $state<{
    x: number
    y: number
    blockId: string
    blockType: string
    selectedText: string
  } | null>(null)

  function updateSelection(): void {
    if (!ondiscusswithagent) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      pill = null
      return
    }
    const selectedText = selection.toString()
    if (!selectedText.trim()) {
      pill = null
      return
    }
    const range = selection.getRangeAt(0)
    const node = range.commonAncestorContainer
    const from = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
    const block = from?.closest('[data-block-id]')
    if (!block || !panelEl?.contains(block)) {
      pill = null
      return
    }
    const rect = range.getBoundingClientRect()
    pill = {
      x: rect.left,
      y: rect.bottom + 6,
      blockId: block.getAttribute('data-block-id') ?? '',
      blockType: block.getAttribute('data-block-type') ?? 'block',
      selectedText,
    }
  }

  function handlePanelMouseUp(event: MouseEvent): void {
    // Ignore the pill's own mouseup — it would clear the pill before the click.
    if ((event.target as Element | null)?.closest('[data-panel-discuss]')) return
    // A double-click's word selection lands after its mouseup, so read the
    // selection on the next frame rather than inside the handler.
    requestAnimationFrame(updateSelection)
  }

  function discussSelection(): void {
    const current = pill
    if (!current) return
    pill = null
    ondiscusswithagent?.(
      {
        kind: 'block',
        blockId: current.blockId,
        blockType: current.blockType,
        content: describeBlock(spec.elements[current.blockId]),
        selectedText: current.selectedText,
      },
      { x: current.x, y: current.y },
    )
  }

  const initialState = $state<Record<string, unknown>>({})

  const actionHandlers: Record<string, (params: Record<string, unknown>) => void | Promise<void>> = {
    send_to_agent: handleSendToAgent,
    open_file: handleOpenFile,
    show_diff: handleShowDiff,
    dismiss_panel: handleDismiss,
    set_state: handleSetState,
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={panelEl}
  class="flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden bg-zinc-950 p-4"
  onmouseup={handlePanelMouseUp}
  onkeyup={updateSelection}
  onscroll={() => (pill = null)}
>
  <JsonUIProvider state={initialState} actions={actionHandlers}>
    <Renderer spec={renderSpec} {registry} />
  </JsonUIProvider>
</div>

{#if pill}
  <button
    type="button"
    data-panel-discuss
    class="fixed z-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 shadow-lg shadow-black/50 hover:border-orange-500 hover:bg-orange-500/15 hover:text-orange-200"
    style:left="{pill.x}px"
    style:top="{pill.y}px"
    title="Discuss this block with an agent"
    onmousedown={(e) => {
      // Keep the browser from collapsing the selection before we read it.
      e.preventDefault()
      discussSelection()
    }}
    onclick={discussSelection}
  >
    ✦ Discuss this
  </button>
{/if}
