<script lang="ts">
  import { Renderer, JsonUIProvider } from '@json-render/svelte'
  import { registry } from './registry'
  import type { Spec } from '../../../shared/gen-ui-catalog'
  import { openDiffTab } from '../../stores/diffReview.svelte'
  import { tabsStore, tabIdFor, type FileTab } from '../../stores/tabsStore.svelte'

  interface Props {
    spec: Spec
    /** Source terminal id, if any — used to route `send_to_agent` writes to
     * the originating Claude session and as the panel's identity for rate
     * limiting. Phase-2 always provides this; absent only in dev demos. */
    terminalId?: string
    /** Active worktree this panel belongs to. Used to scope file/diff opens. */
    worktreePath: string
    onclose?: () => void
  }

  let { spec, terminalId, worktreePath, onclose }: Props = $props()

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

  async function handleOpenFile(params: Record<string, unknown>): Promise<void> {
    const path = typeof params['path'] === 'string' ? params['path'] : ''
    if (!path) return
    const tab: FileTab = {
      kind: 'file',
      id: tabIdFor({ kind: 'file', path }),
      path,
      modified: false,
    }
    tabsStore.open(worktreePath, tab)
  }

  async function handleShowDiff(params: Record<string, unknown>): Promise<void> {
    const commitHash = typeof params['commitHash'] === 'string' ? params['commitHash'] : ''
    if (!commitHash) return
    openDiffTab(worktreePath, commitHash, `Commit ${commitHash.slice(0, 7)}`)
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

  const initialState = $state<Record<string, unknown>>({})

  const actionHandlers: Record<string, (params: Record<string, unknown>) => void | Promise<void>> = {
    send_to_agent: handleSendToAgent,
    open_file: handleOpenFile,
    show_diff: handleShowDiff,
    dismiss_panel: handleDismiss,
    set_state: handleSetState,
  }
</script>

<div class="flex h-full flex-col overflow-y-auto bg-zinc-950 p-4">
  <JsonUIProvider state={initialState} actions={actionHandlers}>
    <Renderer {spec} {registry} />
  </JsonUIProvider>
</div>
