<script lang="ts">
  /**
   * One session: the real terminal, the keys a phone lacks, a composer — and
   * what the agent has changed.
   *
   * A detail screen, so it gets the shell's back button. It has genuinely two
   * panes, which is the one thing that earns a segmented control, and it is
   * labelled for this screen: Terminal / Changes. The panes are not navigation
   * — switching them adds nothing for Back to undo — but a diff opened in
   * Changes is, so leaving Changes for Terminal closes it: Back from the
   * terminal must never close a diff nobody can see.
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
   *  - Changes holds the repo/worktree the reader picked and the log, and
   *    four reads paid for them. Re-issuing those on every visit is the same waste
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
  import DiscardConfirm from './DiscardConfirm.svelte'
  import { nav } from './lib/nav.svelte'
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
    /** This is the screen on top of the tab being shown. */
    visible?: boolean
    /** Leave this screen; called once a discard has been confirmed. */
    onleave?: () => void
  }

  let { session, connection, focusComposer = false, visible = true, onleave }: Props = $props()

  let confirmingDiscard = $state(false)

  /**
   * Asked before Back leaves: a recording in progress would be destroyed by
   * leaving, so it is asked about rather than lost. Typed text is not — the
   * reply field is scratch, and Back from a session is how you step away.
   */
  export function holdForRecording(): boolean {
    if (!composer?.dictating()) return false
    confirmingDiscard = true
    return true
  }

  let caps = $state<AgentCapabilities | null>(null)
  let composer = $state<VoiceComposer | undefined>()

  const PANES = [
    { id: 'terminal', label: 'Terminal' },
    { id: 'changes', label: 'Changes' },
  ] as const
  let pane = $state<(typeof PANES)[number]['id']>('terminal')

  function selectPane(next: (typeof PANES)[number]['id']): void {
    pane = next
    if (next === 'changes') return
    const diff = nav
      .stack('sessions')
      .find((e) => e.kind === 'changes-diff' && e.terminalId === session.terminalId)
    if (diff) nav.close(diff.id)
  }
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

<div class="flex h-full min-h-0 flex-col" data-testid="session-screen" data-terminal-id={session.terminalId}>
  <div class="flex flex-none gap-1 border-b border-zinc-800 p-2" role="tablist" data-testid="session-panes">
    {#each PANES as entry (entry.id)}
      <button
        type="button"
        role="tab"
        aria-selected={pane === entry.id}
        onclick={() => selectPane(entry.id)}
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
      <ChangesPane {session} {connection} active={visible && pane === 'changes'} />
    </div>
  {/if}

  <div
    class="flex-none space-y-2 border-t border-zinc-800 bg-zinc-950 p-2
      {pane === 'terminal' ? '' : 'hidden'}"
  >
    <KeyBar onkey={writeKey} />
    <VoiceComposer bind:this={composer} onsend={send} placeholder="Reply to {session.label}…" />
  </div>
</div>

{#if confirmingDiscard}
  <DiscardConfirm
    title="Discard this recording?"
    body="It hasn’t been transcribed yet — leaving throws it away."
    testid="recording-discard-confirm"
    onkeep={() => { confirmingDiscard = false }}
    ondiscard={() => {
      confirmingDiscard = false
      composer?.discardRecording()
      onleave?.()
    }}
  />
{/if}
