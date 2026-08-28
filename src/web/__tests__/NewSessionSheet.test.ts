import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import NewSessionSheet from '../NewSessionSheet.svelte'

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

  it('closes straight away when there is nothing to lose', async () => {
    mount()
    await fireEvent.click(screen.getByTestId('sheet-close'))
    expect(screen.queryByTestId('discard-confirm')).toBeNull()
    expect(closed).toBe(1)
  })
})
