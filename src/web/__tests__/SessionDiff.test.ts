import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import SessionDiff from '../SessionDiff.svelte'
import '../app.css'
import { initAgentThreadsListeners, _resetAgentThreadsForTests } from '../../renderer/stores/agentThreads.svelte'
import type { AgentThread, AgentThreadOp, ThreadChange } from '../../shared/agent-threads'
import { _resetThreadDraftsForTests } from '../lib/thread-drafts.svelte'

/**
 * Tap-to-comment on the session's diff. A comment becomes an `add-thread` op
 * to main and nothing else — main alone writes to the agent — and a thread
 * shows under the line it is about.
 */

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  ' four',
].join('\n')

let invoke: ReturnType<typeof vi.fn>
let dispose: () => void
let rev = 1
let changed: (c: ThreadChange) => void
let refuse: Error | null

function thread(id: string, over: Partial<AgentThread> = {}): AgentThread {
  return {
    id,
    sessionId: 's1',
    worktreePath: '/wt',
    anchor: { path: 'src/a.ts', startLine: 2, endLine: 2, snippet: 'TWO', before: 'one', after: 'three\nfour', context: 'file' },
    status: 'open',
    messages: [{ id: 'm_aaaaaaaa', author: 'user', body: 'Why upper case?', at: '2026-10-08T10:00:00.000Z', delivery: 'failed' }],
    lastReadAt: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    ...over,
  }
}

function put(t: AgentThread): void {
  changed({ threadId: t.id, thread: t, rev: ++rev })
}

function renderDiff(commit = 'uncommitted') {
  return render(SessionDiff, { diff: DIFF, sessionId: 's1', view: { worktreePath: '/wt', commit }, visible: true })
}

function row(text: string): HTMLElement {
  const match = screen.getAllByTestId('diff-line').find((el) => el.textContent?.includes(text))
  if (!match) throw new Error(`no diff row containing ${text}`)
  return match
}

beforeEach(() => {
  refuse = null
  invoke = vi.fn(async (channel: string, op?: AgentThreadOp) => {
    if (channel === 'agent-threads:load') return { threads: [], rev: 0 }
    if (channel === 'agent-threads:retry') return true
    if (channel === 'agent-threads:op' && op?.kind === 'add-thread') {
      if (refuse) throw refuse
      const t = thread(op.thread.id, {
        anchor: op.thread.anchor,
        messages: [{ id: op.message.id, author: 'user', body: op.message.body, at: '2026-10-08T11:00:00.000Z', delivery: 'held', heldReason: 'busy' }],
      })
      return { threadId: t.id, thread: t, rev: ++rev }
    }
    return null
  })
  vi.stubGlobal('api', {
    invoke,
    on: vi.fn((channel: string, cb: (c: ThreadChange) => void) => {
      if (channel === 'agent-threads:changed') changed = cb
      return () => {}
    }),
  })
  dispose = initAgentThreadsListeners()
})

afterEach(() => {
  expect(invoke).not.toHaveBeenCalledWith('pty:write', expect.anything(), expect.anything())
  dispose()
  _resetAgentThreadsForTests()
  _resetThreadDraftsForTests()
  vi.unstubAllGlobals()
})

describe('SessionDiff tap-to-comment', () => {
  it('makes new-side lines tap targets and leaves deletions and hunk headers alone', () => {
    renderDiff()
    expect(row('TWO').tagName).toBe('BUTTON')
    expect(row('three').tagName).toBe('BUTTON')
    expect(row('two').tagName).toBe('DIV')
    expect(screen.getByTestId('diff-hunk').closest('li')?.querySelector('button')).toBeNull()
  })

  it('starts a thread on the tapped line, with its context, and shows it under the row', async () => {
    renderDiff()
    await fireEvent.click(row('TWO'))
    const composer = screen.getByTestId('thread-composer')
    await fireEvent.input(within(composer).getByLabelText('Comment for the agent'), { target: { value: '  Why upper case?  ' } })
    await fireEvent.click(within(composer).getByText('Send to agent'))

    await waitFor(() => expect(screen.queryByTestId('thread-composer')).toBeNull())
    const op = invoke.mock.calls.find(([c]) => c === 'agent-threads:op')?.[1] as Extract<AgentThreadOp, { kind: 'add-thread' }>
    expect(op.thread).toMatchObject({
      sessionId: 's1',
      worktreePath: '/wt',
      anchor: { path: 'src/a.ts', startLine: 2, endLine: 2, snippet: 'TWO', before: 'one', after: 'three\nfour', context: { commit: 'uncommitted' } },
    })
    expect(op.message.body).toBe('Why upper case?')

    // The new thread opens under its line, expanded, with its delivery state.
    const inline = screen.getByTestId('inline-threads')
    expect(inline.closest('li')?.querySelector('[data-testid="diff-line"]')).toHaveTextContent('TWO')
    expect(within(inline).getByText("waiting for the agent's turn to end")).toBeInTheDocument()
  })

  it("anchors a commit's diff to that commit", async () => {
    renderDiff('abc1234')
    await fireEvent.click(row('three'))
    await fireEvent.input(screen.getByLabelText('Comment for the agent'), { target: { value: 'ok?' } })
    await fireEvent.click(screen.getByText('Send to agent'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agent-threads:op', expect.objectContaining({ kind: 'add-thread' })))
    const op = invoke.mock.calls.find(([c]) => c === 'agent-threads:op')?.[1] as Extract<AgentThreadOp, { kind: 'add-thread' }>
    expect(op.thread.anchor).toMatchObject({ startLine: 3, context: { commit: 'abc1234' } })
  })

  it('keeps the text and says why when main refuses the thread', async () => {
    refuse = new Error('Malformed thread op')
    renderDiff()
    await fireEvent.click(row('TWO'))
    const box = screen.getByLabelText('Comment for the agent') as HTMLTextAreaElement
    await fireEvent.input(box, { target: { value: 'hello' } })
    await fireEvent.click(screen.getByText('Send to agent'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Malformed thread op')
    expect(box.value).toBe('hello')
  })

  it('closes the composer on Cancel or a second tap on its line', async () => {
    renderDiff()
    await fireEvent.click(row('TWO'))
    await fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByTestId('thread-composer')).toBeNull()
    await fireEvent.click(row('TWO'))
    await fireEvent.click(row('TWO'))
    expect(screen.queryByTestId('thread-composer')).toBeNull()
  })
})

describe('SessionDiff composer drafts', () => {
  const box = (): HTMLTextAreaElement => screen.getByLabelText('Comment for the agent') as HTMLTextAreaElement

  // The Changes pane remounts the diff on every reload, retry and Back.
  it('keeps the open composer and its text across a remount', async () => {
    const { unmount } = renderDiff()
    await fireEvent.click(row('TWO'))
    await fireEvent.input(box(), { target: { value: 'half a thought' } })
    unmount()

    renderDiff()
    expect(screen.getByTestId('thread-composer').closest('li')?.querySelector('[data-testid="diff-line"]')).toHaveTextContent('TWO')
    expect(box().value).toBe('half a thought')
  })

  it('never carries text to another line: each line keeps its own draft', async () => {
    renderDiff()
    await fireEvent.click(row('TWO'))
    await fireEvent.input(box(), { target: { value: 'about TWO' } })
    await fireEvent.click(row('three'))
    expect(screen.getAllByTestId('thread-composer')).toHaveLength(1)
    expect(box().value).toBe('')
    await fireEvent.click(row('TWO'))
    expect(box().value).toBe('about TWO')
  })

  it("keeps a draft per diff: a commit's line is not the working copy's", async () => {
    const { unmount } = renderDiff()
    await fireEvent.click(row('TWO'))
    await fireEvent.input(box(), { target: { value: 'uncommitted note' } })
    unmount()
    renderDiff('abc1234')
    expect(screen.queryByTestId('thread-composer')).toBeNull()
    await fireEvent.click(row('TWO'))
    expect(box().value).toBe('')
  })

  it('drops the text on Cancel and once sent', async () => {
    renderDiff()
    await fireEvent.click(row('TWO'))
    await fireEvent.input(box(), { target: { value: 'never mind' } })
    await fireEvent.click(screen.getByText('Cancel'))
    await fireEvent.click(row('TWO'))
    expect(box().value).toBe('')

    await fireEvent.input(box(), { target: { value: 'sent' } })
    await fireEvent.click(screen.getByText('Send to agent'))
    await waitFor(() => expect(screen.queryByTestId('thread-composer')).toBeNull())
    await fireEvent.click(row('TWO'))
    expect(box().value).toBe('')
  })
})

describe('SessionDiff drafts on a diff that moved', () => {
  const box = (): HTMLTextAreaElement => screen.getByLabelText('Comment for the agent') as HTMLTextAreaElement
  const LONG = 'const answer = computeTheAnswer(input)'
  const before = (body: string[]) => ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', `@@ -1,1 +1,${body.length} @@`, ...body].join('\n')
  const mountOn = (diff: string) =>
    render(SessionDiff, { diff, sessionId: 's1', view: { worktreePath: '/wt', commit: 'uncommitted' }, visible: true })

  it('never re-anchors a draft onto the code that took its line; it waits for a tap', async () => {
    const first = mountOn(before([' one', '+TWO', ' three']))
    await fireEvent.click(row('TWO'))
    await fireEvent.input(box(), { target: { value: 'why upper?' } })
    first.unmount()

    // The agent added two lines above: line 2 is now other code, TWO is line 4.
    mountOn(before([' one', '+new a', '+new b', '+TWO', ' three']))
    expect(screen.queryByTestId('thread-composer')).toBeNull()
    expect(screen.getByTestId('thread-composer-detached')).toHaveTextContent('has changed')
    expect(box().value).toBe('why upper?')
    expect(screen.queryByText('Send to agent')).toBeNull()

    await fireEvent.click(row('TWO'))
    expect(screen.queryByTestId('thread-composer-detached')).toBeNull()
    expect(box().value).toBe('why upper?')
    await fireEvent.click(screen.getByText('Send to agent'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agent-threads:op', expect.objectContaining({ kind: 'add-thread' })))
    const op = invoke.mock.calls.find(([c]) => c === 'agent-threads:op')?.[1] as Extract<AgentThreadOp, { kind: 'add-thread' }>
    expect(op.thread.anchor).toMatchObject({ startLine: 4, snippet: 'TWO' })
  })

  it('follows a distinctive line that moved', async () => {
    const first = mountOn(before([' one', `+${LONG}`]))
    await fireEvent.click(row(LONG))
    await fireEvent.input(box(), { target: { value: 'naming?' } })
    first.unmount()

    mountOn(before([' one', '+inserted', `+${LONG}`]))
    expect(screen.getByTestId('thread-composer').closest('li')?.querySelector('[data-testid="diff-line"]')).toHaveAttribute('data-line', '3')
    expect(box().value).toBe('naming?')
  })
})

describe('SessionDiff inline threads', () => {
  it('shows an open thread under its line, with Retry for a failed message', async () => {
    put(thread('t_aaaaaaaa'))
    put(thread('t_bbbbbbbb', { status: 'resolved' }))
    put(thread('t_cccccccc', { anchor: { ...thread('x').anchor, startLine: 30, endLine: 30 } }))
    renderDiff()
    const cards = screen.getAllByTestId('thread-card')
    expect(cards.map((c) => c.dataset.threadId)).toEqual(['t_aaaaaaaa'])
    expect(cards[0]!.closest('li:not([data-testid])')?.querySelector('[data-testid="diff-line"]')).toHaveTextContent('TWO')

    await fireEvent.click(within(cards[0]!).getByTestId('thread-toggle'))
    await fireEvent.click(within(cards[0]!).getByText('Retry'))
    expect(invoke).toHaveBeenCalledWith('agent-threads:retry', 's1', 'm_aaaaaaaa')
  })

  it('keeps a thread resolved here under its line while it is open, offering Reopen', async () => {
    put(thread('t_aaaaaaaa'))
    renderDiff()
    await fireEvent.click(screen.getByTestId('thread-toggle'))
    await fireEvent.click(screen.getByText('Resolve'))
    expect(invoke).toHaveBeenCalledWith('agent-threads:op', { kind: 'set-status', threadId: 't_aaaaaaaa', status: 'resolved' })
    put(thread('t_aaaaaaaa', { status: 'resolved' }))
    await waitFor(() => expect(screen.getByText('Reopen')).toBeInTheDocument())
  })

  it("does not show a commit's thread in the uncommitted diff", () => {
    put(thread('t_aaaaaaaa', { anchor: { ...thread('x').anchor, context: { commit: 'abc1234' } } }))
    renderDiff()
    expect(screen.queryByTestId('thread-card')).toBeNull()
  })
})

describe('SessionDiff on a long line', () => {
  // A phone can't reach a composer or thread that scrolled away with the line.
  it('keeps the composer and threads in view when the line is scrolled sideways', async () => {
    const long = `+${'x'.repeat(400)}`
    const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,0 +1,1 @@', long].join('\n')
    put(thread('t_aaaaaaaa', { anchor: { ...thread('x').anchor, startLine: 1, endLine: 1 } }))
    const host = document.createElement('div')
    host.style.width = '360px'
    document.body.append(host)
    render(SessionDiff, { target: host, props: { diff, sessionId: 's1', view: { worktreePath: '/wt', commit: 'uncommitted' }, visible: true } })

    await fireEvent.click(screen.getByTestId('diff-line'))
    const scroller = screen.getByTestId('diff-line').closest('.overflow-x-auto') as HTMLElement
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth * 2)
    scroller.scrollLeft = scroller.scrollWidth
    await new Promise((r) => requestAnimationFrame(r))

    const view = scroller.getBoundingClientRect()
    for (const el of [screen.getByTestId('thread-composer'), screen.getByTestId('inline-threads')]) {
      const box = el.getBoundingClientRect()
      expect(box.left).toBeGreaterThanOrEqual(view.left - 1)
      expect(box.right).toBeLessThanOrEqual(view.right + 1)
    }
    host.remove()
  })
})
