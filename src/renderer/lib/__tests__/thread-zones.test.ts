import * as monaco from 'monaco-editor'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { userEvent } from 'vitest/browser'
import { waitFor } from '@testing-library/svelte'
import { isMonacoCancellation } from './ignore-monaco-cancellation'
import { attachEditorThreads, SAVE_TO_COMMENT, type ThreadHost } from '../thread-zones'
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
let isDirty = false

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
  isDirty = false
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  threads = attachEditorThreads(editor, () => currentHost, { dirty: () => isDirty })
})

afterEach(() => {
  threads.dispose()
  const model = editor.getModel()
  editor.dispose()
  model?.dispose()
  document.body.innerHTML = ''
  dispose()
  _resetAgentThreadsForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

  it('opens a thread on request only where it has a glyph', async () => {
    put(thread('t_aaaaaaaa'))
    sync()
    expect(threads.open('t_missing')).toBe(false)
    expect(threads.open('t_aaaaaaaa')).toBe(true)
    await waitFor(() => expect(document.querySelector('[data-inline-thread="t_aaaaaaaa"]')).not.toBeNull())
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

function composerBox(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on these lines"]')
}

async function openComposerAt(line: number): Promise<HTMLTextAreaElement> {
  editor.setPosition({ lineNumber: line, column: 1 })
  threads.comment()
  return waitFor(() => {
    const b = composerBox()
    expect(b).not.toBeNull()
    return b!
  })
}

const reply = (at: string): ThreadMessage[] => [
  { id: 'm_1', author: 'user', body: 'Why?', at: '2026-10-08T10:00:00.000Z', delivery: 'answered' },
  { id: 'm_2', author: 'agent', body: 'Because.', at },
]

describe('review fixes', () => {
  it('gives an orphaned thread no glyph and no zone', () => {
    put(thread('t_aaaaaaaa', { anchor: { ...thread('x').anchor, orphaned: true } }))
    sync()
    expect(threads.open('t_aaaaaaaa')).toBe(false)
    expect(editor.getLineDecorations(2)?.some((d) => d.options.glyphMarginClassName?.includes('thread-glyph'))).toBeFalsy()
  })

  it('refuses a new comment while the buffer is unsaved, and says why', async () => {
    sync()
    isDirty = true
    threads.refresh()
    expect(editor.getOption(monaco.editor.EditorOption.glyphMargin)).toBe(false)
    editor.setPosition({ lineNumber: 2, column: 1 })
    threads.comment()
    await waitFor(() => expect(document.querySelector('.monaco-editor-overlaymessage')?.textContent).toContain(SAVE_TO_COMMENT))
    expect(composerBox()).toBeNull()

    isDirty = false
    threads.refresh()
    expect(editor.getOption(monaco.editor.EditorOption.glyphMargin)).toBe(true)
  })

  it('keeps glyphs and zones where the unsaved edits moved them', async () => {
    put(thread('t_aaaaaaaa'))
    sync()
    threads.open('t_aaaaaaaa')
    await waitFor(() => expect(document.querySelector('[data-inline-thread]')).not.toBeNull())
    isDirty = true
    editor.executeEdits('test', [{ range: new monaco.Range(1, 1, 1, 1), text: 'new\n' }])

    put(thread('t_aaaaaaaa', {}, reply('2026-10-08T10:01:00.000Z')))
    sync()
    const glyphOn = (line: number): boolean =>
      !!editor.getLineDecorations(line)?.some((d) => d.options.glyphMarginClassName?.startsWith('thread-glyph'))
    expect(glyphOn(3)).toBe(true)
    expect(glyphOn(2)).toBe(false)
    // The zone followed the anchor down to line 4, and stays there.
    await frame()
    expect(editor.getTopForLineNumber(5) - editor.getTopForLineNumber(4)).toBeGreaterThan(40)
  })

  it("keeps a composer's text when another composer replaces it, and restores it there", async () => {
    sync()
    await openComposerAt(1)
    await userEvent.keyboard('First thoughts')
    const other = await openComposerAt(4)
    expect(other.value).toBe('')
    expect(document.querySelectorAll('textarea[aria-label="Comment on these lines"]')).toHaveLength(1)
    expect((await openComposerAt(1)).value).toBe('First thoughts')
  })

  it("keeps a composer's text across a model change", async () => {
    // A model the editor made from `value` is disposed when the editor moves off it.
    const model = monaco.editor.createModel(editor.getValue())
    editor.setModel(model)
    sync()
    await openComposerAt(2)
    await userEvent.keyboard('Half a thought')
    const other = monaco.editor.createModel('other')
    editor.setModel(other)
    expect(composerBox()).toBeNull()
    editor.setModel(model)
    sync()
    expect((await openComposerAt(2)).value).toBe('Half a thought')
    other.dispose()
  })

  it('closes only its own composer when main answers after another one opened', async () => {
    let answer: (v: unknown) => void = () => {}
    invoke.mockImplementationOnce(() => new Promise((r) => (answer = r)))
    sync()
    await openComposerAt(1)
    await userEvent.keyboard('Slow one{Enter}')
    await openComposerAt(4)
    await userEvent.keyboard('Next')
    answer(null)
    await new Promise((r) => setTimeout(r, 20))
    expect(composerBox()?.value).toBe('Next')
    expect(agentThreadsStore.draft(`new|s1|/wt|src/a.ts|file|1-1`)).toBe('')
  })

  it('marks a reply read only while the window is focused', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
    put(thread('t_aaaaaaaa', {}, reply('2026-10-08T10:01:00.000Z')))
    sync()
    threads.open('t_aaaaaaaa')
    await waitFor(() => expect(document.querySelector('[data-inline-thread]')).not.toBeNull())
    await new Promise((r) => setTimeout(r, 50))
    expect(invoke).not.toHaveBeenCalledWith('agent-threads:op', expect.objectContaining({ kind: 'mark-read' }))

    vi.mocked(document.hasFocus).mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agent-threads:op', { kind: 'mark-read', threadId: 't_aaaaaaaa', at: '2026-10-08T10:01:00.000Z' }),
    )
  })

  it("ignores only Monaco's own cancellations", () => {
    const monacoCancel = new Error('Canceled')
    monacoCancel.name = 'Canceled'
    expect(isMonacoCancellation(monacoCancel)).toBe(true)
    expect(isMonacoCancellation(new Error('Canceled'))).toBe(false)
    const other = new Error('request aborted')
    other.name = 'Canceled'
    expect(isMonacoCancellation(other)).toBe(false)
    expect(isMonacoCancellation('Canceled')).toBe(false)
  })
})
