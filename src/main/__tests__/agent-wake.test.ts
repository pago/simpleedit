import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { drain, enqueue, messageState, resetBus, syncPeers, type Peer } from '../agent-bus'
import {
  WAKE_SETTLE_MS,
  beginStop,
  canWake,
  endStop,
  noteNotification,
  noteStatus,
  noteUserInput,
  requestWake,
  resetAgentWake,
  initAgentWake,
  wakeOutlook,
} from '../agent-wake'
import { clearAgentStatusWatchers } from '../agent-status'

function peer(terminalId: string, label: string): Peer {
  return { terminalId, label, provider: 'claude', worktreePath: `/repo/${label}`, status: 'idle' }
}

let writes: Array<{ id: string; data: string }>

beforeEach(() => {
  vi.useFakeTimers()
  resetBus()
  resetAgentWake()
  syncPeers([peer('claude-a', 'alpha'), peer('claude-b', 'beta')])
  writes = []
  initAgentWake((id, data) => writes.push({ id, data }))
})

afterEach(() => {
  resetAgentWake()
  clearAgentStatusWatchers()
  vi.useRealTimers()
})

/** Claude's title reads idle, then its idle-prompt Notification confirms it. */
function idleAtPrompt(id: string): void {
  noteStatus(id, 'idle', true)
  noteNotification(id, 'idle_prompt', 'Claude is waiting for your input')
}

function send(text = 'please rebase'): string {
  const result = enqueue({ from: 'claude-a', to: 'claude-b', text })
  if ('error' in result) throw new Error(result.error)
  requestWake('claude-b')
  return result.message.id
}

describe('agent-wake', () => {
  it('prompts an idle recipient to read its inbox, submitted as a bracketed paste', () => {
    idleAtPrompt('claude-b')
    const id = send()
    expect(writes).toHaveLength(0)

    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
    expect(writes[0].id).toBe('claude-b')
    expect(writes[0].data).toMatch(/^\x1b\[200~\[SimpleEdit\] You have 1 new message from agent session "alpha" \(claude-a\)\. Call the check_inbox tool/)
    expect(writes[0].data.endsWith('\x1b[201~\r')).toBe(true)
    expect(messageState(id)).toBe('notified')
  })

  it('waits for a busy recipient to go idle, then wakes it', () => {
    noteStatus('claude-b', 'running', true)
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS * 4)
    expect(writes).toHaveLength(0)

    idleAtPrompt('claude-b')
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it('does not write once the mail was read during the settle window', () => {
    idleAtPrompt('claude-b')
    send()
    drain('claude-b')
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(0)
  })

  it("never pastes into a prompt the user has typed into", () => {
    noteUserInput('claude-b', 'half a thought')
    idleAtPrompt('claude-b')
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS * 4)
    expect(writes).toHaveLength(0)
    expect(canWake('claude-b')).toBe(false)
    expect(wakeOutlook('claude-b')).toBe('typing')

    // Submitting their prompt clears it; the wake follows the next idle edge.
    noteUserInput('claude-b', '\r')
    noteStatus('claude-b', 'running', true)
    idleAtPrompt('claude-b')
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it('ignores what xterm sends on its own', () => {
    for (const seq of ['\x1b[I', '\x1b[O', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;40R', '\x1b[0n']) {
      noteUserInput('claude-b', seq)
    }
    idleAtPrompt('claude-b')
    expect(wakeOutlook('claude-b')).toBe('waking')
  })

  // Up-arrow recalls history, Esc-Esc opens the rewind picker, `/model` + Enter
  // leaves a picker up: the wake's Enter would act on any of them.
  it('treats any key since the last turn started as a reason not to wake', () => {
    idleAtPrompt('claude-b')
    for (const keys of ['\x1b[A', '\x1b\x1b', '/model\r', '\x03']) {
      noteStatus('claude-b', 'running', true)
      idleAtPrompt('claude-b')
      noteUserInput('claude-b', keys)
      expect(wakeOutlook('claude-b')).toBe('typing')
    }
  })

  it('holds a wake while a Stop hook is being answered', () => {
    syncPeers([peer('claude-a', 'alpha'), { ...peer('claude-b', 'beta'), provider: 'codex' }])
    noteStatus('claude-b', 'idle', true)
    beginStop('claude-b')
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS * 4)
    expect(writes).toHaveLength(0)
    endStop('claude-b')
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it('does not retry a notice that never started a turn', () => {
    idleAtPrompt('claude-b')
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    vi.advanceTimersByTime(10 * 60_000)
    expect(writes).toHaveLength(1)
    expect(wakeOutlook('claude-b')).toBe('busy')
  })

  // Claude turns a prompt idle for ~60s into `waiting` via the Notification
  // hook, and its title never changes after that.
  it("wakes a session whose idle prompt Claude has reported as waiting", () => {
    noteStatus('claude-b', 'idle', true)
    noteStatus('claude-b', 'waiting', true)
    noteNotification('claude-b', 'idle_prompt', 'Claude is waiting for your input')
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it('recognises the idle-prompt reminder by its text on CLIs that send no type', () => {
    noteStatus('claude-b', 'waiting', true)
    noteNotification('claude-b', null, 'Claude is waiting for your input')
    expect(wakeOutlook('claude-b')).toBe('waking')
  })

  it('never wakes into a permission or question prompt, even if the title then reads idle', () => {
    noteStatus('claude-b', 'waiting', true)
    noteNotification('claude-b', 'permission_prompt', 'Claude needs your permission to use Bash')
    noteStatus('claude-b', 'idle', true)
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS * 4)
    expect(writes).toHaveLength(0)
    expect(wakeOutlook('claude-b')).toBe('blocked')
    expect(canWake('claude-b')).toBe(false)

    // An unknown kind blocks too.
    noteStatus('claude-b', 'running', true)
    noteNotification('claude-b', null, 'Something else')
    expect(wakeOutlook('claude-b')).toBe('blocked')
  })

  it('lifts a dialog block once the turn ends', () => {
    noteStatus('claude-b', 'waiting', true)
    send()
    beginStop('claude-b')
    idleAtPrompt('claude-b')
    endStop('claude-b')
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it('hands back to the Stop block once the notices are used up', () => {
    send()
    for (let i = 0; i < 2; i++) {
      noteStatus('claude-b', 'running', true)
      idleAtPrompt('claude-b')
      vi.advanceTimersByTime(WAKE_SETTLE_MS)
    }
    expect(canWake('claude-b')).toBe(false)
  })

  it('stops nagging an agent that ignores the notice', () => {
    send()
    for (let i = 0; i < 4; i++) {
      noteStatus('claude-b', 'running', true)
      idleAtPrompt('claude-b')
      vi.advanceTimersByTime(WAKE_SETTLE_MS)
    }
    expect(writes).toHaveLength(2)
  })

  // Claude's title reads idle under a permission or question dialog too, so
  // only its explicit idle-prompt Notification may lead to a wake.
  it('never wakes a Claude session on its title alone', () => {
    noteStatus('claude-b', 'idle', true)
    send()
    vi.advanceTimersByTime(10 * 60_000)
    expect(writes).toHaveLength(0)
    expect(wakeOutlook('claude-b')).toBe('confirming')

    noteNotification('claude-b', 'idle_prompt', null)
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it("leaves a Claude session's mail to the Stop block until it has sent an idle prompt", () => {
    noteStatus('claude-b', 'running', true)
    send()
    expect(canWake('claude-b')).toBe(false)
    idleAtPrompt('claude-b')
    noteStatus('claude-b', 'running', true)
    expect(canWake('claude-b')).toBe(true)
  })

  it('needs a fresh idle-prompt confirmation after every turn', () => {
    idleAtPrompt('claude-b')
    noteStatus('claude-b', 'running', true)
    noteStatus('claude-b', 'idle', true)
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS * 4)
    expect(writes).toHaveLength(0)
  })

  it('wakes a provider with an explicit idle signal (Codex, OpenCode) on idle alone', () => {
    syncPeers([peer('claude-a', 'alpha'), { ...peer('claude-b', 'beta'), provider: 'codex' }])
    noteStatus('claude-b', 'idle', true)
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it('cannot wake a session whose status was never reported', () => {
    send()
    expect(canWake('claude-b')).toBe(false)
    expect(wakeOutlook('claude-b')).toBe('unknown')
  })

  it('a coarse status cannot override a precise one', () => {
    noteStatus('claude-b', 'running', true)
    noteStatus('claude-b', 'idle', false)
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(0)
  })

  it('forgets an exited session', () => {
    idleAtPrompt('claude-b')
    noteStatus('claude-b', 'exited', false)
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(0)
  })

  // Issue #197, observation 2: several messages queued for an idle session must
  // all reach it, in order, through one wake.
  it('names every queued sender and hands over all queued mail', () => {
    idleAtPrompt('claude-b')
    const long = send('review: ' + 'finding. '.repeat(500))
    const short = send('one more thing')
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
    expect(writes[0].data).toContain('2 new messages')

    expect(drain('claude-b').map((m) => m.id)).toEqual([long, short])
    expect(messageState(long)).toBe('delivered')
    expect(messageState(short)).toBe('delivered')
  })
})
