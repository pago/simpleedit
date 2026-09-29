<script lang="ts">
  /**
   * One session: the real terminal, the keys a phone lacks, a composer — and
   * what the agent has changed.
   *
   * A detail screen, so it gets a back button and no tab bar. It has genuinely
   * two panes now, which is the one thing that earns a segmented control, and
   * it is labelled for this screen: Terminal / Changes.
   *
   * NOTHING here is unmounted by a pane switch; the inactive pane is hidden.
   * The rule is one rule because every part of this screen holds something a
   * switch must not destroy:
   *
   *  - The terminal's attachment fills the gap after a disconnect by byte
   *    offset, and its scrollback is the conversation.
   *  - The composer holds a half-typed reply, and unmounting it DISCARDS a
   *    live recording (see the lifetime note in `VoiceComposer`) — so tapping
   *    Changes and back would silently eat what someone had just dictated.
   *  - Changes holds the repo/worktree/commit the reader picked, and four
   *    reads paid for it. Re-issuing those on every visit is the same waste
   *    the terminal's rule exists to avoid, over a link that is worse.
   *
   * Changes is mounted LAZILY — its first visit builds it — because a session
   * that is only ever read as a terminal should not pay for it at all. After
   * that it stays.
   *
   * The keys and the composer belong to the terminal and are hidden with it:
   * there is nothing on the Changes pane to type at.
   */
  import MobileTerminal from './MobileTerminal.svelte'
  import ChangesPane from './ChangesPane.svelte'
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

  const PANES = [
    { id: 'terminal', label: 'Terminal' },
    { id: 'changes', label: 'Changes' },
  ] as const
  let pane = $state<(typeof PANES)[number]['id']>('terminal')
  /** Changes has been opened at least once, so it exists from here on. */
  let changesBuilt = $state(false)
  $effect(() => {
    if (pane === 'changes') changesBuilt = true
  })

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
  <div class="flex flex-none gap-1 border-b border-zinc-800 p-2" role="tablist" data-testid="session-panes">
    {#each PANES as entry (entry.id)}
      <button
        type="button"
        role="tab"
        aria-selected={pane === entry.id}
        onclick={() => { pane = entry.id }}
        data-testid="pane-{entry.id}"
        class="min-h-8 flex-1 rounded-md text-xs font-medium
          {pane === entry.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 active:bg-zinc-900'}"
      >{entry.label}</button>
    {/each}
  </div>

  <!-- Hidden, never unmounted: see the note at the top of this file. -->
  <div class="min-h-0 flex-1 {pane === 'terminal' ? '' : 'hidden'}">
    <MobileTerminal bind:this={terminal} terminalId={session.terminalId} {connection} />
  </div>

  <!-- Built on first visit, hidden thereafter — never unmounted. -->
  {#if changesBuilt}
    <div class="min-h-0 flex-1 {pane === 'changes' ? '' : 'hidden'}">
      <ChangesPane {session} {connection} />
    </div>
  {/if}

  <div
    class="flex-none space-y-2 border-t border-zinc-800 bg-zinc-950 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]
      {pane === 'terminal' ? '' : 'hidden'}"
  >
    <KeyBar onkey={writeKey} />
    <VoiceComposer bind:this={composer} onsend={send} placeholder="Reply to {session.label}…" />
  </div>
</div>
