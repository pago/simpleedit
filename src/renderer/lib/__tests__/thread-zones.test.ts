import * as monaco from 'monaco-editor'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { userEvent } from 'vitest/browser'
import { waitFor } from '@testing-library/svelte'
import { attachEditorThreads, type ThreadHost } from '../thread-zones'
import { threadGlyphsFor } from '../thread-glyphs'
import { agentThreadsStore, initAgentThreadsListeners, _resetAgentThreadsForTests } from '../../stores/agentThreads.svelte'
import type { AgentThread, AgentThreadOp, ThreadChange, ThreadMessage } from '../../../shared/agent-threads'

let invoke: ReturnType<typeof vi.fn>
let changed: (c: ThreadChange) => void
let dispose: () => void
let rev = 1

const VIEW = { worktreePath: '/wt', path: 'src/a.ts', commit: null }

function thread(id: string, over: Partial<AgentThread> = {}, messages: ThreadMessage[] = []): AgentThread {
  return {
    id,
    sessionId: 's1',
    worktreePath: '/wt',
    anchor: { path: 'src/a.ts', startLine: 2, endLine: 3, snippet: 'b\nc', before: 'a', after: 'd', context: 'file' },
    status: 'open',
    messages: messages.length
      ? messages
      : [{ id: 'm_1', author: 'user', body: 'Why is this async?', at: '2026-10-08T10:00:00.000Z', delivery: 'delivered' }],
    lastReadAt: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    ...over,
  }
}

function put(t: AgentThread): void {
  changed({ threadId: t.id, thread: t, rev: ++rev })
}

const host: ThreadHost = {
  sessionId: 's1',
  anchorFor: (lines) => ({ worktreePath: '/wt', anchor: { path: 'src/a.ts', ...lines, context: 'file' } }),
}

let editor: monaco.editor.IStandaloneCodeEditor
let threads: ReturnType<typeof attachEditorThreads>
let currentHost: ThreadHost | null

function sync(): void {
  threads.set(threadGlyphsFor(agentThreadsStore.forSession('s1'), VIEW))
}

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

async function clickGlyph(selector: string): Promise<void> {
  await frame()
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`no ${selector}`)
  await userEvent.click(el)
}

beforeEach(() => {
  invoke = vi.fn(async (channel: string, op?: AgentThreadOp) => {
    if (channel === 'agent-threads:load') return { threads: [], rev: 0 }
    if (channel === 'agent-threads:op' && op?.kind === 'add-thread') {
      return {
        threadId: op.thread.id,
        thread: thread(op.thread.id, { anchor: op.thread.anchor }, [
          { id: op.message.id, author: 'user', body: op.message.body, at: '2026-10-08T10:00:00.000Z', delivery: 'held', heldReason: 'busy' },
        ]),
        rev: ++rev,
      }
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

  const el = document.createElement('div')
  el.style.cssText = 'width: 600px; height: 400px'
  document.body.append(el)
  editor = monaco.editor.create(el, { value: 'a\nb\nc\nd\ne\nf', glyphMargin: false })
  currentHost = host
  threads = attachEditorThreads(editor, () => currentHost)
})

afterEach(() => {
  threads.dispose()
  editor.getModel()?.dispose()
  editor.dispose()
  document.body.innerHTML = ''
  dispose()
  _resetAgentThreadsForTests()
  vi.unstubAllGlobals()
})

describe('inline threads', () => {
  it('toggles a thread inline from its glyph, under the anchor, and marks it read once on screen', async () => {
    put(thread('t_aaaaaaaa', {}, [
      { id: 'm_1', author: 'user', body: 'Why?', at: '2026-10-08T10:00:00.000Z', delivery: 'answered' },
      { id: 'm_2', author: 'agent', body: 'It **awaits** the lock.', at: '2026-10-08T10:01:00.000Z' },
    ]))
    sync()
    await clickGlyph('.thread-glyph')

    const zone = await waitFor(() => {
      const z = document.querySelector('[data-inline-thread="t_aaaaaaaa"]')
      expect(z).not.toBeNull()
      return z!
    })
    expect(zone.querySelector('strong')?.textContent).toBe('awaits')
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agent-threads:op', { kind: 'mark-read', threadId: 't_aaaaaaaa', at: '2026-10-08T10:01:00.000Z' }),
    )

    // Under the anchor's last line (3), above line 4.
    const line4 = editor.getTopForLineNumber(4)
    const line3 = editor.getTopForLineNumber(3)
    expect(line4 - line3).toBeGreaterThan(40)

    await clickGlyph('.thread-glyph')
    await waitFor(() => expect(document.querySelector('[data-inline-thread]')).toBeNull())
  })

  it('updates with the store and closes when the thread is resolved or removed', async () => {
    put(thread('t_aaaaaaaa'))
    sync()
    await clickGlyph('.thread-glyph')
    await waitFor(() => expect(document.querySelector('[data-inline-thread]')).not.toBeNull())

    put(thread('t_aaaaaaaa', {}, [
      { id: 'm_1', author: 'user', body: 'Why?', at: '2026-10-08T10:00:00.000Z', delivery: 'answered' },
      { id: 'm_2', author: 'agent', body: 'Because.', at: '2026-10-08T10:01:00.000Z' },
    ]))
    await waitFor(() => expect(document.querySelector('[data-inline-thread]')?.textContent).toContain('Because.'))

    put(thread('t_aaaaaaaa', { status: 'resolved' }))
    sync()
    expect(document.querySelector('[data-inline-thread]')).toBeNull()
  })

  it('reveals the thread in the panel from the zone', async () => {
    put(thread('t_aaaaaaaa'))
    sync()
    await clickGlyph('.thread-glyph')
    const reveal = await waitFor(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Show in panel')
      expect(b).toBeDefined()
      return b!
    })
    reveal.click()
    expect(agentThreadsStore.focusFor('s1')).toBe('t_aaaaaaaa')
  })

  it('drops its zones when the model changes or the editor goes', async () => {
    put(thread('t_aaaaaaaa'))
    sync()
    await clickGlyph('.thread-glyph')
    await waitFor(() => expect(document.querySelector('[data-inline-thread]')).not.toBeNull())
    const old = editor.getModel()
    editor.setModel(monaco.editor.createModel('x\ny\nz'))
    old?.dispose()
    expect(document.querySelector('[data-inline-thread]')).toBeNull()
  })

  it("keeps the zone's keys away from Monaco's keybindings", async () => {
    put(thread('t_aaaaaaaa'))
    sync()
    await clickGlyph('.thread-glyph')
    const box = await waitFor(() => {
      const b = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to thread"]')
      expect(b).not.toBeNull()
      return b!
    })
    const seen = vi.fn()
    editor.getContainerDomNode().addEventListener('keydown', seen)
    box.focus()
    await userEvent.keyboard('hi')
    expect(box.value).toBe('hi')
    expect(editor.getValue()).toBe('a\nb\nc\nd\ne\nf')
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('new-thread composer', () => {
  it('shows the "+" only while commenting is possible', async () => {
    sync()
    expect(editor.getOption(monaco.editor.EditorOption.glyphMargin)).toBe(true)
    currentHost = null
    sync()
    expect(editor.getOption(monaco.editor.EditorOption.glyphMargin)).toBe(false)
  })

  it('starts a thread on the selection with ⌘⇧M and opens it inline, leaving the panel alone', async () => {
    sync()
    editor.setSelection(new monaco.Selection(2, 1, 3, 2))
    threads.comment()
    const box = await waitFor(() => {
      const b = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on these lines"]')
      expect(b).not.toBeNull()
      return b!
    })
    expect(document.activeElement).toBe(box)
    expect(document.body.textContent).toContain('New thread · src/a.ts:2-3')
    await userEvent.keyboard('Why is this async?{Enter}')

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agent-threads:op', {
        kind: 'add-thread',
        thread: {
          id: expect.stringMatching(/^t_/),
          sessionId: 's1',
          worktreePath: '/wt',
          anchor: { path: 'src/a.ts', startLine: 2, endLine: 3, snippet: 'b\nc', before: 'a', after: 'd\ne\nf', context: 'file' },
        },
        message: { id: expect.stringMatching(/^m_/), body: 'Why is this async?' },
      }),
    )
    expect(document.querySelector('textarea[aria-label="Comment on these lines"]')).toBeNull()
    expect(agentThreadsStore.focusFor('s1')).toBeNull()
    sync()
    await waitFor(() => expect(document.querySelector('[data-inline-thread]')?.textContent).toContain('Why is this async?'))
  })

  it('opens from the "+" on a hovered line', async () => {
    sync()
    await frame()
    const top = editor.getTopForLineNumber(4) + 5
    const rect = editor.getDomNode()!.getBoundingClientRect()
    const target = document.elementFromPoint(rect.left + 100, rect.top + top)
    if (!target) throw new Error('no line')
    await userEvent.hover(target)
    await clickGlyph('.thread-glyph-add')
    await waitFor(() => expect(document.body.textContent).toContain('New thread · src/a.ts:4'))
  })

  it('cancels with Esc and keeps the text when main refuses it', async () => {
    sync()
    editor.setPosition({ lineNumber: 1, column: 1 })
    threads.comment()
    const box = await waitFor(() => {
      const b = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on these lines"]')
      expect(b).not.toBeNull()
      return b!
    })
    invoke.mockRejectedValueOnce(new Error('Malformed thread op'))
    await userEvent.keyboard('Hm{Enter}')
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Malformed thread op'))
    expect(box.value).toBe('Hm')

    await userEvent.keyboard('{Escape}')
    expect(document.querySelector('textarea[aria-label="Comment on these lines"]')).toBeNull()
  })
})
