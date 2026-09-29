import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import NewSessionSheet from '../NewSessionSheet.svelte'
import { SESSION_CREATE_UNWITNESSED } from '../../shared/ipc-types'

/**
 * The sheet's promises, not the composer's mechanism.
 *
 * `VoiceComposer.test.ts` already proves the microphone and the mandatory
 * transcript review; this sheet reuses that component whole. What is new here
 * is what it commits to: one session per confirmed intent, a brief that is
 * never lost silently, and a nudge that never becomes a gate.
 */

let invoke: ReturnType<typeof vi.fn>
let created: { terminalId: string; label: string }[]
let closed: number

/** Resolvers for in-flight `session:create` calls, so a test can hold one open. */
let answer: ((value: { terminalId: string; label: string }) => void) | null
let fail: ((reason: Error) => void) | null

function mount(connection: 'open' | 'connecting' | 'closed' = 'open') {
  return render(NewSessionSheet, {
    props: {
      connection,
      oncreated: (value: { terminalId: string; label: string }) => created.push(value),
      onclose: () => { closed++ },
    },
  })
}

/** Every `session:create` the sheet has issued, oldest first. */
function creates(): { requestId: string; brief: string }[] {
  return invoke.mock.calls
    .filter((call) => call[0] === 'session:create')
    .map((call) => call[1] as { requestId: string; brief: string })
}

/** Wait until the sheet has issued exactly `n` create calls. */
async function untilCreates(n: number): Promise<void> {
  await waitFor(() => expect(creates()).toHaveLength(n))
}

/** Type a brief into the composer's field, as a user with a keyboard would. */
async function type(text: string): Promise<void> {
  const field = screen.getByTestId('composer-text')
  await fireEvent.input(field, { target: { value: text } })
}

const FULL_BRIEF =
  'The mobile session list shows every session as freshly blocked; make statusSince survive a reconnect and check it against the desktop sidebar.'

beforeEach(() => {
  created = []
  closed = 0
  answer = null
  fail = null
  invoke = vi.fn((channel: string) => {
    if (channel === 'stt:status') return Promise.resolve({ ready: true, hint: '' })
    if (channel === 'session:create') {
      return new Promise((resolve, reject) => {
        answer = resolve
        fail = reject
      })
    }
    return Promise.resolve(undefined)
  })
  ;(window as unknown as { api: Record<string, unknown> }).api = { invoke, on: vi.fn(() => () => {}) }
})

describe('NewSessionSheet', () => {
  it('starts a session with the brief and hands the session back', async () => {
    mount()
    await type(FULL_BRIEF)
    await fireEvent.click(screen.getByTestId('composer-send'))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('session:create', expect.anything()))
    const request = invoke.mock.calls.find((c) => c[0] === 'session:create')![1]
    expect(request.brief).toBe(FULL_BRIEF)
    expect(typeof request.requestId).toBe('string')
    expect(request.requestId.length).toBeGreaterThan(0)

    answer!({ terminalId: 'agent-1', label: 'The mobile session list' })
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0].terminalId).toBe('agent-1')
  })

  it('names the same intent when a failed start is tried again', async () => {
    mount()
    await type(FULL_BRIEF)
    await fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fail).not.toBeNull())
    fail!(new Error('Connection lost'))
    await screen.findByTestId('composer-error')

    // The brief survives a failed start — it is the whole thing the user said.
    expect((screen.getByTestId('composer-text') as HTMLTextAreaElement).value).toBe(FULL_BRIEF)

    await fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === 'session:create')).toHaveLength(2),
    )
    const [first, second] = invoke.mock.calls
      .filter((c) => c[0] === 'session:create')
      .map((c) => c[1].requestId)
    // Same intent, so main can recognise it as the one the user confirmed —
    // and hand back the session it may already have started.
    expect(second).toBe(first)
  })

  it('mints a new intent for the next session', async () => {
    mount()
    await type(FULL_BRIEF)
    await fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(answer).not.toBeNull())
    answer!({ terminalId: 'agent-1', label: 'first' })
    await waitFor(() => expect(created).toHaveLength(1))

    await type('And now the second one, with enough words in it to satisfy the nudge threshold here.')
    await fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === 'session:create')).toHaveLength(2),
    )
    const [first, second] = invoke.mock.calls
      .filter((c) => c[0] === 'session:create')
      .map((c) => c[1].requestId)
    expect(second).not.toBe(first)
  })

  it('says it cannot be cancelled while the start is in flight', async () => {
    mount()
    await type(FULL_BRIEF)
    await fireEvent.click(screen.getByTestId('composer-send'))

    await screen.findByTestId('starting-note')
    // Nothing here offers a cancel it cannot honour: a spawn in flight is not
    // recallable, so Cancel is disabled rather than lying.
    expect(screen.getByTestId('sheet-close')).toBeDisabled()

    answer!({ terminalId: 'agent-1', label: 'x' })
    await waitFor(() => expect(screen.queryByTestId('starting-note')).toBeNull())
  })

  it('nudges a thin brief without refusing to start it', async () => {
    mount()
    await type('fix the tests')
    await screen.findByTestId('brief-nudge')
    // The nudge is advice. Start still works — a wrong refusal costs more.
    expect(screen.getByTestId('composer-send')).not.toBeDisabled()
  })

  it('previews the label the session will carry once the brief is complete', async () => {
    mount()
    await type(FULL_BRIEF)
    const preview = await screen.findByTestId('label-preview')
    expect(preview.textContent).toContain('The mobile session list shows every')
  })

  it('refuses to start while the socket is down, and keeps the brief', async () => {
    mount('closed')
    await screen.findByTestId('offline-note')
    await type(FULL_BRIEF)
    await fireEvent.click(screen.getByTestId('composer-send'))

    await screen.findByTestId('composer-error')
    expect(invoke).not.toHaveBeenCalledWith('session:create', expect.anything())
    expect((screen.getByTestId('composer-text') as HTMLTextAreaElement).value).toBe(FULL_BRIEF)
  })

  it('never loses a brief silently', async () => {
    mount()
    await type(FULL_BRIEF)
    await fireEvent.click(screen.getByTestId('sheet-close'))

    // The brief is not persisted anywhere, so dismissing it is destructive and
    // has to be said out loud.
    await screen.findByTestId('discard-confirm')
    expect(closed).toBe(0)

    await fireEvent.click(screen.getByTestId('discard-confirmed'))
    expect(closed).toBe(1)
  })

  it('asks the same intent again before it will make a second session', async () => {
    mount()
    await type(FULL_BRIEF)
    await fireEvent.click(screen.getByTestId('composer-send'))
    await untilCreates(1)

    // The session was made and main cached the answer; the socket dropped
    // before the result frame arrived. From here the phone cannot tell this
    // apart from a start that did nothing — so the escape must ASK, not assume.
    fail!(new Error('Connection lost'))
    await screen.findByTestId('composer-error')

    await fireEvent.click(await screen.findByTestId('start-anyway'))
    await untilCreates(2)
    expect(creates()[1].requestId).toBe(creates()[0].requestId)

    // Main hands back the session it already has, and that is the end of it.
    answer!({ terminalId: 'agent-1', label: 'The mobile session list' })
    await waitFor(() => expect(created).toHaveLength(1))
    expect(creates()).toHaveLength(2)
  })

  it('only mints a new intent once the old one comes back unwitnessed', async () => {
    mount()
    await type(FULL_BRIEF)
    await fireEvent.click(screen.getByTestId('composer-send'))
    await untilCreates(1)
    // Main never re-spawns an intent nobody witnessed, so every plain retry
    // returns this same uncertainty. Without an exit the only escape is
    // Discard, which destroys the brief the user just dictated.
    fail!(new Error(SESSION_CREATE_UNWITNESSED))
    await screen.findByTestId('composer-error')

    await fireEvent.click(await screen.findByTestId('start-anyway'))
    // First the same intent, one more time — the only way to learn whether it
    // produced something.
    await untilCreates(2)
    expect(creates()[1].requestId).toBe(creates()[0].requestId)
    fail!(new Error(SESSION_CREATE_UNWITNESSED))

    // Still unwitnessed. NOW the duplicate risk is the user's deliberate
    // choice, and the brief they dictated goes with it.
    await untilCreates(3)
    expect(creates()[2].requestId).not.toBe(creates()[0].requestId)
    expect(creates()[2].brief).toBe(FULL_BRIEF)
    expect((screen.getByTestId('composer-text') as HTMLTextAreaElement).value).toBe(FULL_BRIEF)
  })

  it('reports a plain failure from the escape without asking again', async () => {
    mount()
    await type(FULL_BRIEF)
    await fireEvent.click(screen.getByTestId('composer-send'))
    await untilCreates(1)
    fail!(new Error('Connection lost'))
    await screen.findByTestId('composer-error')

    await fireEvent.click(await screen.findByTestId('start-anyway'))
    await untilCreates(2)
    fail!(new Error('That SimpleEdit window has no repo open yet.'))

    const reported = await screen.findByTestId('anyway-error')
    expect(reported.textContent).toContain('no repo open')
    // Not an unwitnessed outcome, so nothing here may quietly try a new intent.
    expect(creates()).toHaveLength(2)
  })

  it('does not offer the way out before anything has failed', async () => {
    mount()
    await type(FULL_BRIEF)
    expect(screen.queryByTestId('start-anyway')).toBeNull()
  })

  it('puts Start out of reach while the discard confirm is up', async () => {
    mount()
    await type(FULL_BRIEF)
    await fireEvent.click(screen.getByTestId('sheet-close'))
    await screen.findByTestId('discard-confirm')

    // Not merely covered — unreachable. A keyboard user could otherwise tab
    // back to Start, fire it, then discard: the sheet unmounts mid-call, the
    // session appears nowhere, and the obvious next move starts a second one.
    expect(screen.getByTestId('new-session-sheet')).toHaveAttribute('inert')
  })

  it('treats Escape as a way out, and asks before it costs the brief', async () => {
    mount()
    await fireEvent.keyDown(screen.getByTestId('new-session-sheet'), { key: 'Escape' })
    expect(closed).toBe(1)

    closed = 0
    await type(FULL_BRIEF)
    await fireEvent.keyDown(screen.getByTestId('new-session-sheet'), { key: 'Escape' })
    await screen.findByTestId('discard-confirm')
    expect(closed).toBe(0)
  })

  it('warns the browser before it takes the brief away', async () => {
    mount()
    const unloadWith = (): boolean => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    // Nothing to lose yet.
    expect(unloadWith()).toBe(false)

    await type(FULL_BRIEF)
    // An iOS PWA reclaiming the tab is the likeliest way a dictated brief goes.
    expect(unloadWith()).toBe(true)
  })

  it('closes straight away when there is nothing to lose', async () => {
    mount()
    await fireEvent.click(screen.getByTestId('sheet-close'))
    expect(screen.queryByTestId('discard-confirm')).toBeNull()
    expect(closed).toBe(1)
  })

  // What the navigation stack asks before the system Back gesture pops it.
  it('holds Back for a brief, and asks about it, but lets an empty sheet go', async () => {
    const { component } = mount()
    expect(component.holdForDraft()).toBe(false)
    expect(screen.queryByTestId('discard-confirm')).toBeNull()

    await type(FULL_BRIEF)
    expect(component.holdForDraft()).toBe(true)
    await waitFor(() => expect(screen.getByTestId('discard-confirm')).toBeTruthy())
    expect(closed).toBe(0)
  })
})
