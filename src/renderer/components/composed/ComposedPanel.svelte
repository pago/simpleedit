<script lang="ts">
  import { Renderer, JsonUIProvider } from '@json-render/svelte'
  import { registry } from './registry'
  import type { Spec } from '../../../shared/gen-ui-catalog'

  interface Props {
    spec: Spec
    /** Source terminal id, if any — passed through so action handlers can
     * route `send_to_agent` back to the right PTY. Phase 2 reads it. */
    terminalId?: string
    onclose?: () => void
  }

  let { spec, terminalId: _terminalId, onclose: _onclose }: Props = $props()

  const initialState = $state<Record<string, unknown>>({})

  const actionHandlers = $state<Record<string, (params: Record<string, unknown>) => void | Promise<void>>>({
    send_to_agent: (_params) => {
      console.warn('[gen-ui] send_to_agent action fired (handler wired in Phase 2)')
    },
    open_file: (_params) => {
      console.warn('[gen-ui] open_file action fired (handler wired in Phase 2)')
    },
    show_diff: (_params) => {
      console.warn('[gen-ui] show_diff action fired (handler wired in Phase 2)')
    },
    dismiss_panel: () => {
      console.warn('[gen-ui] dismiss_panel action fired (handler wired in Phase 2)')
    },
    set_state: (_params) => {
      console.warn('[gen-ui] set_state action fired (handler wired in Phase 2)')
    },
  })
</script>

<div class="flex h-full flex-col overflow-y-auto bg-zinc-950 p-4">
  <JsonUIProvider state={initialState} actions={actionHandlers}>
    <Renderer {spec} {registry} />
  </JsonUIProvider>
</div>
