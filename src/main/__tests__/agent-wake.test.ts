import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { drain, enqueue, messageState, resetBus, syncPeers, type Peer } from '../agent-bus'
import {
  WAKE_SETTLE_MS,
  WAKE_UNANSWERED_MS,
  beginStop,
  canWake,
  endStop,
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

function send(text = 'please rebase'): string {
  const result = enqueue({ from: 'claude-a', to: 'claude-b', text })
  if ('error' in result) throw new Error(result.error)
  requestWake('claude-b')
  return result.message.id
}

describe('agent-wake', () => {
  it('prompts an idle recipient to read its inbox, submitted as a bracketed paste', () => {
    noteStatus('claude-b', 'idle', true)
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

    noteStatus('claude-b', 'idle', true)
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it('does not write once the mail was read during the settle window', () => {
    noteStatus('claude-b', 'idle', true)
    send()
    drain('claude-b')
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(0)
  })

  it("never pastes into a prompt the user has typed into", () => {
    noteUserInput('claude-b', 'half a thought')
    noteStatus('claude-b', 'idle', true)
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS * 4)
    expect(writes).toHaveLength(0)
    expect(canWake('claude-b')).toBe(false)
    expect(wakeOutlook('claude-b')).toBe('typing')

    // Submitting their prompt clears it; the wake follows the next idle edge.
    noteUserInput('claude-b', '\r')
    noteStatus('claude-b', 'running', true)
    noteStatus('claude-b', 'idle', true)
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it('does not mistake terminal reports and arrow keys for typing', () => {
    for (const seq of ['\x1b[I', '\x1b[O', '\x1b[A', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b[?1;2c', '\x1bOP']) {
      noteUserInput('claude-b', seq)
    }
    noteStatus('claude-b', 'idle', true)
    expect(wakeOutlook('claude-b')).toBe('waking')
  })

  it('treats Ctrl-C and Ctrl-U as clearing the prompt', () => {
    noteStatus('claude-b', 'idle', true)
    noteUserInput('claude-b', 'abc')
    expect(wakeOutlook('claude-b')).toBe('typing')
    noteUserInput('claude-b', '\x03')
    expect(wakeOutlook('claude-b')).toBe('waking')
    noteUserInput('claude-b', 'abc')
    noteUserInput('claude-b', '\x15')
    expect(wakeOutlook('claude-b')).toBe('waking')
  })

  it('keeps a prompt dirty through Enters that only add a line', () => {
    noteStatus('claude-b', 'idle', true)
    // A multi-line paste, Meta-Enter and backslash-Enter all leave text behind.
    for (const input of [['\x1b[200~line one\rline two\x1b[201~'], ['abc', '\x1b\r'], ['abc\\', '\r']]) {
      noteUserInput('claude-b', '\x15')
      for (const chunk of input) noteUserInput('claude-b', chunk)
      expect(wakeOutlook('claude-b')).toBe('typing')
    }
    // A paste followed by Enter is a submit (how a panel sends to the agent).
    noteUserInput('claude-b', '\x1b[200~do it\x1b[201~\r')
    expect(wakeOutlook('claude-b')).toBe('waking')
  })

  it('does not read an X10 mouse report as typing', () => {
    noteStatus('claude-b', 'idle', true)
    noteUserInput('claude-b', '\x1b[M !!')
    expect(wakeOutlook('claude-b')).toBe('waking')
  })

  it('holds a wake while a Stop hook is being answered', () => {
    noteStatus('claude-b', 'idle', true)
    beginStop('claude-b')
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS * 4)
    expect(writes).toHaveLength(0)
    endStop('claude-b')
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it('wakes again if its notice never started a turn', () => {
    noteStatus('claude-b', 'idle', true)
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(1)
    vi.advanceTimersByTime(WAKE_UNANSWERED_MS + WAKE_SETTLE_MS)
    expect(writes).toHaveLength(2)
  })

  it('hands back to the Stop block once the notices are used up', () => {
    send()
    for (let i = 0; i < 2; i++) {
      noteStatus('claude-b', 'running', true)
      noteStatus('claude-b', 'idle', true)
      vi.advanceTimersByTime(WAKE_SETTLE_MS)
    }
    expect(canWake('claude-b')).toBe(false)
  })

  it('stops nagging an agent that ignores the notice', () => {
    send()
    for (let i = 0; i < 4; i++) {
      noteStatus('claude-b', 'running', true)
      noteStatus('claude-b', 'idle', true)
      vi.advanceTimersByTime(WAKE_SETTLE_MS)
    }
    expect(writes).toHaveLength(2)
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
    noteStatus('claude-b', 'idle', true)
    noteStatus('claude-b', 'exited', false)
    send()
    vi.advanceTimersByTime(WAKE_SETTLE_MS)
    expect(writes).toHaveLength(0)
  })

  // Issue #197, observation 2: several messages queued for an idle session must
  // all reach it, in order, through one wake.
  it('names every queued sender and hands over all queued mail', () => {
    noteStatus('claude-b', 'idle', true)
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
