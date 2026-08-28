<script lang="ts">
  /**
   * One session: the real terminal, the keys a phone lacks, and a composer.
   *
   * A detail screen, so it gets a back button and no tab bar. No segmented
   * control either — the plan reserves one for a screen that genuinely has two
   * panes, and Terminal / Changes is only one pane until the review surface
   * lands.
   */
  import MobileTerminal from './MobileTerminal.svelte'
  import KeyBar from './KeyBar.svelte'
  import VoiceComposer from './VoiceComposer.svelte'
  import type { RemoteConnection } from './api-shim'
  import type { AccessoryKey } from './lib/keys'
  import type { AgentCapabilities, WindowSession } from '../shared/ipc-types'

  interface Props {
    session: WindowSession
    connection: RemoteConnection
    /**
     * This screen was opened by tapping a notification, so put the cursor in
     * the composer. Never the microphone: iOS requires a gesture for that, and
     * a hot mic on wake would be wrong where it does not.
     */
    focusComposer?: boolean
  }

  let { session, connection, focusComposer = false }: Props = $props()

  let caps = $state<AgentCapabilities | null>(null)
  let composer = $state<VoiceComposer | undefined>()

  $effect(() => {
    if (focusComposer) composer?.focusField()
  })
  // The terminal owns key encoding: what an arrow sends depends on the cursor
  // mode, which only it knows.
  let terminal = $state<MobileTerminal | undefined>()

  // How this agent wants a newline. Read from main's provider descriptor
  // rather than branched on a provider name, exactly as the desktop does.
  $effect(() => {
    const provider = session.provider
    caps = null
    if (!provider) return
    void window.api
      .invoke('agent:capabilities', provider)
      .then((next) => { caps = next })
      .catch(() => { /* fall back to the safe encoding below */ })
  })

  function writeKey(key: AccessoryKey): void {
    terminal?.pressKey(key)
  }

  /**
   * A dictated paragraph must not submit on its first newline.
   *
   * For an agent that needs it, each newline becomes the CSI-u sequence the
   * desktop already writes for Shift+Enter. For anything else — a plain shell,
   * or an agent whose own TUI handles Shift+Enter and therefore has no byte we
   * could send instead — the lines are joined with a space, which is what a
   * spoken paragraph means anyway and which cannot submit halfway through.
   */
  function encode(text: string): string {
    const lines = text.split(/\r?\n/)
    return caps?.shiftEnter === 'escape-newline'
      ? lines.join('\x1b[13;2u')
      : lines.map((line) => line.trim()).filter(Boolean).join(' ')
  }

  async function send(text: string): Promise<void> {
    await window.api.invoke('pty:write', session.terminalId, `${encode(text)}\r`)
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="session-screen">
  <div class="min-h-0 flex-1">
    <MobileTerminal bind:this={terminal} terminalId={session.terminalId} {connection} />
  </div>

  <div class="flex-none space-y-2 border-t border-zinc-800 bg-zinc-950 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
    <KeyBar onkey={writeKey} />
    <VoiceComposer bind:this={composer} onsend={send} placeholder="Reply to {session.label}…" />
  </div>
</div>
