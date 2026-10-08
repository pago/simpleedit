<script lang="ts">
  /**
   * One session: the real terminal, the keys a phone lacks, a composer — and
   * what the agent has changed.
   *
   * A detail screen, so it gets the shell's back button. It has genuinely
   * separate panes, which is the one thing that earns a segmented control, and
   * it is labelled for this screen: Terminal / Changes / Threads (an agent's
   * comment threads, with an unread count). The panes are not navigation
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
   * that it stays. Threads follows the same rule: each thread's composer holds
   * a half-typed reply.
   *
   * The keys and the composer belong to the terminal and are hidden with it:
   * the Changes pane has nothing to type at, and Threads has its own composers.
   */
  import { untrack } from 'svelte'
  import MobileTerminal from './MobileTerminal.svelte'
  import ChangesPane from './ChangesPane.svelte'
  import ThreadsPane from './ThreadsPane.svelte'
  import { agentThreadsStore } from '../renderer/stores/agentThreads.svelte'
  import KeyBar from './KeyBar.svelte'
  import VoiceComposer from './VoiceComposer.svelte'
  import DiscardConfirm from './DiscardConfirm.svelte'
  import { nav } from './lib/nav.svelte'
  import type { RemoteConnection } from './api-shim'
  import type { AccessoryKey } from './lib/keys'
  import type { SendOutcome } from './lib/send-outcome'
  import { agentSubmitWrite } from '../shared/agent-submit'
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
    /** Show the Threads pane: a tap on a thread-reply notification. A new object per tap. */
    openThread?: { threadId: string }
    /** This is the screen on top of the tab being shown. */
    visible?: boolean
    /** Leave this screen; called once a discard has been confirmed. */
    onleave?: () => void
  }

  let { session, connection, focusComposer = false, openThread, visible = true, onleave }: Props = $props()

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

  /** The same question as `holdForRecording`, without raising the confirm. */
  export function isRecording(): boolean {
    return composer?.dictating() ?? false
  }

  let caps = $state<AgentCapabilities | null>(null)
  let composer = $state<VoiceComposer | undefined>()

  const ALL_PANES = [
    { id: 'terminal', label: 'Terminal' },
    { id: 'changes', label: 'Changes' },
    { id: 'threads', label: 'Threads' },
  ] as const
  type PaneId = (typeof ALL_PANES)[number]['id']
  // A plain terminal has no agent to hold a thread with.
  let panes = $derived(session.kind === 'terminal' ? ALL_PANES.filter((p) => p.id !== 'threads') : ALL_PANES)
  let pane = $state<PaneId>('terminal')
  let unreadThreads = $derived(agentThreadsStore.unreadCount(session.terminalId))

  function selectPane(next: PaneId): void {
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
  let threadsBuilt = $state(false)
  $effect(() => {
    if (pane === 'threads') threadsBuilt = true
  })

  $effect(() => {
    if (focusComposer) composer?.focusField()
  })
  $effect(() => {
    if (openThread && session.kind !== 'terminal') untrack(() => selectPane('threads'))
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

  const SUBMIT_GAP_MS = 50

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

  /**
   * An agent gets the reply and Enter in one write (see `agentSubmitWrite`), so
   * there is no point at which half of it has arrived.
   *
   * A plain terminal may not honour bracketed paste, so it gets the text and
   * then Enter as two writes a beat apart (two writes with no pause can still
   * be read as one). If the text arrived but Enter did not, the field is
   * cleared anyway: the text is already at the prompt, and a resend would type
   * it twice.
   */
  async function send(text: string): Promise<SendOutcome> {
    if (session.kind === 'agent') {
      await window.api.invoke('pty:write', session.terminalId, agentSubmitWrite(text))
      return
    }
    await window.api.invoke('pty:write', session.terminalId, encode(text))
    try {
      await new Promise((resolve) => setTimeout(resolve, SUBMIT_GAP_MS))
      await window.api.invoke('pty:write', session.terminalId, '\r')
    } catch {
      return { warning: 'The text is at the prompt, but Enter did not get through. Press ⏎ to run it.' }
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="session-screen" data-terminal-id={session.terminalId}>
  <div class="flex flex-none gap-1 border-b border-zinc-800 p-2" role="tablist" data-testid="session-panes">
    {#each panes as entry (entry.id)}
      <button
        type="button"
        role="tab"
        aria-selected={pane === entry.id}
        onclick={() => selectPane(entry.id)}
        data-testid="pane-{entry.id}"
        class="flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium
          {pane === entry.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 active:bg-zinc-900'}"
      >
        {entry.label}
        {#if entry.id === 'threads' && unreadThreads > 0}
          <span
            class="min-w-4 rounded-full bg-blue-500 px-1 text-[10px] leading-4 text-white"
            aria-label="{unreadThreads} unread"
            data-testid="threads-unread"
          >{unreadThreads}</span>
        {/if}
      </button>
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

  {#if threadsBuilt}
    <div class="min-h-0 flex-1 {pane === 'threads' ? '' : 'hidden'}">
      <ThreadsPane sessionId={session.terminalId} active={visible && pane === 'threads'} />
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
