import { render, screen, waitFor, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../PromptField.svelte', async () => ({ default: (await import('./StubPromptField.svelte')).default }))

import BacklogView from '../BacklogView.svelte'
import BacklogArrivalNotice from '../BacklogArrivalNotice.svelte'
import { backlogStore, initBacklogListeners, _resetBacklogForTests, type BacklogDraft } from '../../../stores/backlog.svelte'
import { sessionsStore } from '../../../stores/sessions.svelte'
import { uiView } from '../../../stores/uiView.svelte'
import { _resetAllowlistedModelsForTests, targetKey } from '../../../lib/agentModels'
import type { BacklogItem, BacklogOpResult, BacklogSnapshot } from '../../../../shared/backlog'

const P = '/repo/project.git'
let invoke: ReturnType<typeof vi.fn>
let changed: (s: BacklogSnapshot) => void
let dispose: () => void
let rev = 1
/** Answers `backlog:op`; the default applies adds and updates as main would. */
let onOp: (ops: Array<Record<string, unknown>>) => Promise<BacklogOpResult> | BacklogOpResult

function item(id: string, over: Partial<BacklogItem> = {}): BacklogItem {
  return { id, prompt: `Do the ${id} work\nwith details`, label: `Item ${id}`, version: 1, createdAt: 'a', updatedAt: 'a', createdBy: 'desktop', ...over }
}

function snapshot(items: BacklogItem[]): BacklogSnapshot {
  return { project: P, items, rev: ++rev }
}

function put(items: BacklogItem[]): void {
  changed(snapshot(items))
}

function ops(): Array<Array<Record<string, unknown>>> {
  return invoke.mock.calls.filter((c) => c[0] === 'backlog:op').map((c) => c[1])
}

async function answer(channel: string, arg: unknown): Promise<unknown> {
  if (channel === 'backlog:load') return { project: P, items: [item('b_aaaaaaaa'), item('b_bbbbbbbb'), item('b_cccccccc')], rev: 1 }
  if (channel === 'backlog:op') return onOp(arg as Array<Record<string, unknown>>)
  if (channel === 'models:config-get') return { defaults: {}, submenuAllowlist: ['claude-opus'] }
  if (channel === 'models:claude') return [{ model: 'claude-opus', displayName: 'Opus' }]
  if (channel === 'models:codex' || channel === 'models:opencode' || channel === 'models:installed') return []
  return undefined
}

const prompt = (): HTMLTextAreaElement => screen.getByLabelText('Backlog prompt')

/** Main's side of `backlog:op`, for adds and updates: an existing id is dropped, an update bumps the version. */
function applyLikeMain(batch: Array<Record<string, unknown>>): BacklogOpResult {
  let items = [...backlogStore.items]
  for (const op of batch) {
    if (op.kind === 'add') {
      const added = op.item as BacklogItem
      if (!items.some((i) => i.id === added.id)) items.push({ ...added, version: 1, createdAt: 'a', updatedAt: 'a', createdBy: 'desktop' })
    } else if (op.kind === 'update') {
      items = items.map((i) => {
        if (i.id !== op.id) return i
        const next: Record<string, unknown> = { ...i, version: i.version + 1 }
        for (const [k, v] of Object.entries(op.patch as Record<string, unknown>)) {
          if (v === null) delete next[k]
          else next[k] = v
        }
        return next as unknown as BacklogItem
      })
    }
  }
  return { ok: true, snapshot: snapshot(items) }
}

beforeEach(async () => {
  _resetBacklogForTests()
  _resetAllowlistedModelsForTests()
  onOp = applyLikeMain
  invoke = vi.fn(answer)
  vi.stubGlobal('api', {
    invoke,
    on: (channel: string, cb: (s: BacklogSnapshot) => void) => {
      if (channel === 'backlog:changed') changed = cb
      return () => {}
    },
    once: vi.fn(),
  })
  dispose = initBacklogListeners()
  void backlogStore.load()
  await waitFor(() => expect(backlogStore.items).toHaveLength(3))
})

afterEach(() => {
  dispose()
  vi.unstubAllGlobals()
})

describe('BacklogView list', () => {
  it('lists the items in order with their model and what an agent added marked', async () => {
    put([item('b_aaaaaaaa', { createdBy: 'agent', createdBySession: 'parser rewrite' }), item('b_bbbbbbbb')])
    render(BacklogView)
    const rows = await screen.findAllByTestId('backlog-item')
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Item b_aaaaaaaa'), expect.stringContaining('Item b_bbbbbbbb')])
    expect(rows[0].textContent).toContain('Default · added by parser rewrite')
  })

  it('shows the first item by default', async () => {
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toBe('Do the b_aaaaaaaa work\nwith details'))
    expect((screen.getByLabelText('Session name') as HTMLInputElement).value).toBe('Item b_aaaaaaaa')
    expect((await screen.findAllByTestId('backlog-item'))[0].getAttribute('aria-current')).toBe('true')
  })

  it('starts an item, opens its session and selects the next one', async () => {
    invoke.mockImplementation(async (channel: string, arg: unknown) =>
      channel === 'backlog:start' ? { terminalId: 'agent-1', label: 'x' } : answer(channel, arg),
    )
    const select = vi.spyOn(sessionsStore, 'select').mockImplementation(() => {})
    uiView.show('backlog')
    render(BacklogView)
    await waitFor(() => expect(backlogStore.selectedId).toBe('b_aaaaaaaa'))
    await fireEvent.click((await screen.findAllByRole('button', { name: 'Start' }))[0])
    await waitFor(() => expect(select).toHaveBeenCalledWith('agent-1'))
    expect(invoke).toHaveBeenCalledWith('backlog:start', expect.objectContaining({ id: 'b_aaaaaaaa' }))
    expect(uiView.current()).toBe('workspace')
    expect(backlogStore.selectedId).toBe('b_bbbbbbbb')
    select.mockRestore()
  })

  it('shows why a start failed, and a may-have-started warning', async () => {
    put([
      item('b_aaaaaaaa', { lastStart: { outcome: 'failed', reason: 'no codex', at: 'now' } }),
      item('b_bbbbbbbb', { lastStart: { outcome: 'unconfirmed', reason: 'no answer', at: 'now' } }),
      item('b_cccccccc', { starting: true }),
    ])
    render(BacklogView)
    expect(await screen.findByText(/Didn't start: no codex/)).toBeTruthy()
    expect(screen.getByText(/May have started/)).toBeTruthy()
    expect(screen.getByText('Starting…')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Start' })).toHaveLength(2)
  })

  it('reorders by drag and drop through main', async () => {
    render(BacklogView)
    const rows = await screen.findAllByTestId('backlog-item')
    await fireEvent.dragStart(rows[2], { dataTransfer: new DataTransfer() })
    await fireEvent.dragOver(rows[0], { dataTransfer: new DataTransfer() })
    await fireEvent.drop(rows[0], { dataTransfer: new DataTransfer() })
    await waitFor(() => expect(ops()).toContainEqual([{ kind: 'reorder', ids: ['b_cccccccc', 'b_aaaaaaaa', 'b_bbbbbbbb'] }]))
  })

  it('deletes only after confirming', async () => {
    render(BacklogView)
    await fireEvent.click(await screen.findByRole('button', { name: 'Delete Item b_bbbbbbbb' }))
    expect(ops()).toEqual([])
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(ops()).toEqual([[{ kind: 'remove', id: 'b_bbbbbbbb' }]]))
  })

  it("the arrival notice's Edit selects the item in the backlog", async () => {
    const added = item('b_dddddddd', { createdBy: 'agent', createdBySession: 'planner' })
    put([...backlogStore.items, added])
    render(BacklogArrivalNotice)
    await fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(backlogStore.selectedId).toBe('b_dddddddd')
    expect(uiView.current()).toBe('backlog')
  })
})

describe('BacklogItemDetail autosave', () => {
  it('saves typing after a pause, sending only what changed', async () => {
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'my text' } })
    expect(screen.getByText('Saving…')).toBeTruthy()
    expect(ops()).toEqual([])
    await waitFor(() => expect(ops()).toEqual([[{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 1, patch: { prompt: 'my text' } }]]), {
      timeout: 2000,
    })
  })

  it('sends a picked model, and lists one the picker lacks', async () => {
    const odd = { provider: 'claude' as const, model: { provider: 'ollama' as const, model: 'qwen3:8b' } }
    put([item('b_aaaaaaaa', { target: odd })])
    render(BacklogView)
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement
    await waitFor(() => expect(select.selectedOptions[0]?.textContent).toBe('Claude · qwen3:8b'))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Claude · Opus' })).toBeTruthy())
    await fireEvent.change(select, { target: { value: targetKey({ provider: 'claude', model: { provider: 'anthropic', model: 'claude-opus' } }) } })
    await waitFor(
      () =>
        expect(ops()).toEqual([
          [{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 1, patch: { target: { provider: 'claude', model: { provider: 'anthropic', model: 'claude-opus' } } } }],
        ]),
      { timeout: 2000 },
    )
  })

  it('flushes a pending save before switching item', async () => {
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'typed just now' } })
    await fireEvent.click(screen.getByText('Item b_bbbbbbbb'))
    await waitFor(() => expect(prompt().value).toContain('b_bbbbbbbb'))
    expect(ops()).toEqual([[{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 1, patch: { prompt: 'typed just now' } }]])
  })

  it('offers Keep mine and Take theirs when the item changed elsewhere', async () => {
    const theirs = item('b_aaaaaaaa', { prompt: 'their text', version: 2 })
    onOp = (batch) => {
      if (batch[0].baseVersion === 1) return { ok: false, conflict: { id: 'b_aaaaaaaa', current: theirs }, snapshot: snapshot([theirs]) }
      return { ok: true, snapshot: snapshot([{ ...theirs, prompt: 'my text', version: 3 }]) }
    }
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'my text' } })
    await fireEvent.click(screen.getByText('Item b_bbbbbbbb'))
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy()
    // The switch waits: the text is still here.
    expect(prompt().value).toBe('my text')
    expect(screen.getByRole('button', { name: 'Take theirs' })).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(ops()).toHaveLength(2))
    expect(ops()[1]).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 2, patch: { prompt: 'my text' } }])
    expect(screen.queryByText(/changed somewhere else/)).toBeNull()
  })

  it('Take theirs replaces the text with theirs', async () => {
    const theirs = item('b_aaaaaaaa', { prompt: 'their text', version: 2 })
    onOp = () => ({ ok: false, conflict: { id: 'b_aaaaaaaa', current: theirs }, snapshot: snapshot([theirs]) })
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'my text' } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Take theirs' }, { timeout: 2000 }))
    await waitFor(() => expect(prompt().value).toBe('their text'))
  })

  it("adopts another client's change while nothing is unsaved, and never over typing", async () => {
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    put([item('b_aaaaaaaa', { prompt: 'from the phone', version: 2 })])
    await waitFor(() => expect(prompt().value).toBe('from the phone'))
    await fireEvent.input(prompt(), { target: { value: 'mine, unsaved' } })
    put([item('b_aaaaaaaa', { prompt: 'from an agent', version: 3 })])
    await new Promise((r) => setTimeout(r, 50))
    expect(prompt().value).toBe('mine, unsaved')
  })
})

describe('a new item', () => {
  it('creates nothing when left untouched', async () => {
    render(BacklogView)
    await fireEvent.click(screen.getByRole('button', { name: '+ New' }))
    await waitFor(() => expect(prompt().value).toBe(''))
    expect(screen.getByText('New item')).toBeTruthy()
    await fireEvent.click(screen.getByText('Item b_bbbbbbbb'))
    await waitFor(() => expect(prompt().value).toContain('b_bbbbbbbb'))
    expect(screen.queryByText('New item')).toBeNull()
    expect(ops()).toEqual([])
  })

  it('is added once it has a prompt, and a retry reuses its id', async () => {
    let calls = 0
    onOp = (batch) => {
      calls++
      if (calls === 1) throw new Error('socket closed')
      const added = batch[0].item as BacklogItem
      return { ok: true, snapshot: snapshot([...backlogStore.items, { ...added, version: 1, createdAt: 'a', updatedAt: 'a', createdBy: 'desktop' }]) }
    }
    render(BacklogView)
    await fireEvent.click(screen.getByRole('button', { name: '+ New' }))
    await waitFor(() => expect(prompt().value).toBe(''))
    await fireEvent.input(prompt(), { target: { value: 'later work' } })
    expect(await screen.findByText(/Not saved: socket closed/, undefined, { timeout: 2000 })).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(backlogStore.items).toHaveLength(4))
    const [first, second] = ops().map((batch) => (batch[0].item as { id: string }).id)
    expect(first).toBe(second)
    expect(backlogStore.selectedId).toBe(first)
    expect(prompt().value).toBe('later work')
  })

  it('is added with just a title, and cannot be started until it has a prompt', async () => {
    onOp = (batch) => {
      const added = batch[0].item as BacklogItem
      return { ok: true, snapshot: snapshot([...backlogStore.items, { ...added, version: 1, createdAt: 'a', updatedAt: 'a', createdBy: 'desktop' }]) }
    }
    render(BacklogView)
    await fireEvent.click(screen.getByRole('button', { name: '+ New' }))
    await waitFor(() => expect(prompt().value).toBe(''))
    await fireEvent.input(screen.getByLabelText('Session name'), { target: { value: 'Look into flaky CI' } })
    await waitFor(() => expect(backlogStore.items).toHaveLength(4), { timeout: 2000 })
    expect(ops()[0]).toEqual([{ kind: 'add', item: { id: expect.stringMatching(/^b_/), prompt: '', label: 'Look into flaky CI' } }])
    const start = (await screen.findAllByRole('button', { name: 'Start' }))[3] as HTMLButtonElement
    expect(start.disabled).toBe(true)
    expect(start.title).toBe('Write a prompt before starting this item.')
  })
})

describe('saving, in sequence', () => {
  it('saves twice in a row against the version the first save produced', async () => {
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'one' } })
    await waitFor(() => expect(ops()).toHaveLength(1), { timeout: 2000 })
    await fireEvent.input(prompt(), { target: { value: 'one two' } })
    await waitFor(() => expect(ops()).toHaveLength(2), { timeout: 2000 })
    expect(ops()[1]).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 2, patch: { prompt: 'one two' } }])
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy())
    expect(screen.queryByText(/changed somewhere else/)).toBeNull()
  })

  it('updates a new item once it was added, rather than adding it again', async () => {
    render(BacklogView)
    await fireEvent.click(screen.getByRole('button', { name: '+ New' }))
    await waitFor(() => expect(prompt().value).toBe(''))
    await fireEvent.input(prompt(), { target: { value: 'first' } })
    await waitFor(() => expect(backlogStore.items).toHaveLength(4), { timeout: 2000 })
    const id = backlogStore.items[3].id
    await fireEvent.input(prompt(), { target: { value: 'first, then more' } })
    await waitFor(() => expect(ops()).toHaveLength(2), { timeout: 2000 })
    expect(ops()[1]).toEqual([{ kind: 'update', id, baseVersion: 1, patch: { prompt: 'first, then more' } }])
  })

  it("takes the saved state from main's copy: a tidied name is not an edit", async () => {
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(screen.getByLabelText('Session name'), { target: { value: '  spaced   out  ' } })
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy(), { timeout: 2000 })
    expect(ops()).toEqual([[{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 1, patch: { label: 'spaced out' } }]])
    await new Promise((r) => setTimeout(r, 800))
    expect(ops()).toHaveLength(1)
  })

  it('a retried add that main already had sends what was typed in between', async () => {
    let calls = 0
    onOp = (batch) => {
      calls++
      const result = applyLikeMain(batch)
      // The first add lands, but its answer is lost.
      if (calls === 1) {
        changed(result.snapshot)
        throw new Error('socket closed')
      }
      return result
    }
    render(BacklogView)
    await fireEvent.click(screen.getByRole('button', { name: '+ New' }))
    await waitFor(() => expect(prompt().value).toBe(''))
    await fireEvent.input(prompt(), { target: { value: 'later work' } })
    expect(await screen.findByText(/Not saved: socket closed/, undefined, { timeout: 2000 })).toBeTruthy()
    // Typing more retries on its own.
    await fireEvent.input(prompt(), { target: { value: 'later work, more' } })
    await waitFor(() => expect(ops()).toHaveLength(3), { timeout: 2000 })
    const id = (ops()[0][0].item as { id: string }).id
    expect(ops()[2]).toEqual([{ kind: 'update', id, baseVersion: 1, patch: { prompt: 'later work, more' } }])
    await waitFor(() => expect(backlogStore.get(id)?.prompt).toBe('later work, more'))
  })

  it('Save as new keeps the text of an item that left the backlog', async () => {
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'still mine' } })
    put([item('b_bbbbbbbb'), item('b_cccccccc')])
    await fireEvent.click(await screen.findByRole('button', { name: 'Save as new item' }, { timeout: 2000 }))
    await waitFor(() => expect(ops().at(-1)?.[0]).toMatchObject({ kind: 'add', item: { prompt: 'still mine', label: 'Item b_aaaaaaaa' } }))
    const fresh = (ops().at(-1)?.[0].item as { id: string }).id
    await waitFor(() => expect(backlogStore.selectedId).toBe(fresh))
    expect(prompt().value).toBe('still mine')
  })

  it('saves before Start, so the session starts from the latest text', async () => {
    const order: string[] = []
    invoke.mockImplementation(async (channel: string, arg: unknown) => {
      if (channel === 'backlog:op' || channel === 'backlog:start') order.push(channel)
      return channel === 'backlog:start' ? { terminalId: 'agent-1', label: 'x' } : answer(channel, arg)
    })
    const select = vi.spyOn(sessionsStore, 'select').mockImplementation(() => {})
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'final words' } })
    await fireEvent.click((await screen.findAllByRole('button', { name: 'Start' }))[0])
    await waitFor(() => expect(order).toEqual(['backlog:op', 'backlog:start']))
    expect(ops()[0]).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 1, patch: { prompt: 'final words' } }])
    select.mockRestore()
  })
})

describe('a save that meets a start', () => {
  function refuseWhileStarting(): void {
    onOp = (batch) => {
      const cur = backlogStore.get('b_aaaaaaaa')
      if (cur?.starting) return { ok: false, conflict: { id: 'b_aaaaaaaa', current: cur }, snapshot: snapshot(backlogStore.items) }
      return applyLikeMain(batch)
    }
  }

  it('waits, then saves once the start failed', async () => {
    refuseWhileStarting()
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    put([item('b_aaaaaaaa', { starting: true }), item('b_bbbbbbbb')])
    await fireEvent.input(prompt(), { target: { value: 'mine' } })
    expect(await screen.findByText(/being started right now/, undefined, { timeout: 2000 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Keep mine' })).toBeNull()
    put([item('b_aaaaaaaa', { lastStart: { outcome: 'failed', reason: 'no codex', at: 'now' } }), item('b_bbbbbbbb')])
    await waitFor(() => expect(ops().at(-1)).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 1, patch: { prompt: 'mine' } }]))
    await waitFor(() => expect(screen.queryByText(/being started/)).toBeNull())
    expect(prompt().value).toBe('mine')
  })

  it('offers Save as new once the start made it a session', async () => {
    refuseWhileStarting()
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    put([item('b_aaaaaaaa', { starting: true }), item('b_bbbbbbbb')])
    await fireEvent.input(prompt(), { target: { value: 'mine' } })
    expect(await screen.findByText(/being started right now/, undefined, { timeout: 2000 })).toBeTruthy()
    put([item('b_bbbbbbbb')])
    expect(await screen.findByRole('button', { name: 'Save as new item' })).toBeTruthy()
    expect(prompt().value).toBe('mine')
  })
})

describe('leaving the item', () => {
  it('sends pending typing at once when the window unloads', async () => {
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'typed before ⌘R' } })
    expect(ops()).toEqual([])
    window.dispatchEvent(new Event('beforeunload'))
    expect(ops()).toEqual([[{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 1, patch: { prompt: 'typed before ⌘R' } }]])
  })

  it("holds the arrival notice's Edit while the open item can't be saved", async () => {
    const theirs = item('b_aaaaaaaa', { prompt: 'their text', version: 2 })
    onOp = () => ({ ok: false, conflict: { id: 'b_aaaaaaaa', current: theirs }, snapshot: snapshot(backlogStore.items) })
    render(BacklogView)
    render(BacklogArrivalNotice)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'my text' } })
    put([...backlogStore.items, item('b_dddddddd', { createdBy: 'agent' })])
    await fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy()
    expect(backlogStore.selectedId).toBe('b_aaaaaaaa')
    expect(prompt().value).toBe('my text')
  })

  it('saves before an outside selection change', async () => {
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'quick edit' } })
    expect(await backlogStore.requestSelect('b_cccccccc')).toBe(true)
    expect(ops()).toEqual([[{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 1, patch: { prompt: 'quick edit' } }]])
    await waitFor(() => expect(prompt().value).toContain('b_cccccccc'))
  })

  it('keeps text it could not save when the view closes, and shows it again', async () => {
    onOp = () => {
      throw new Error('socket closed')
    }
    const view = render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'not lost' } })
    view.unmount()
    await waitFor(() => expect(backlogStore.draft('b_aaaaaaaa')?.prompt).toBe('not lost'))
    onOp = applyLikeMain
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toBe('not lost'))
    await waitFor(() => expect(backlogStore.get('b_aaaaaaaa')?.prompt).toBe('not lost'), { timeout: 2000 })
    await waitFor(() => expect(backlogStore.draft('b_aaaaaaaa')).toBeUndefined())
  })
})

describe('focus and drag', () => {
  it('focuses the prompt for a new item only', async () => {
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    expect(document.activeElement).not.toBe(prompt())
    await fireEvent.click(screen.getByRole('button', { name: '+ New' }))
    await waitFor(() => expect(document.activeElement).toBe(prompt()))
  })

  it('drops on the end slot to move an item last', async () => {
    render(BacklogView)
    const rows = await screen.findAllByTestId('backlog-item')
    const end = screen.getByTestId('backlog-drop-end')
    await fireEvent.dragStart(rows[0], { dataTransfer: new DataTransfer() })
    await fireEvent.dragOver(end, { dataTransfer: new DataTransfer() })
    expect(end.className).toContain('border-blue-500')
    await fireEvent.drop(end, { dataTransfer: new DataTransfer() })
    await waitFor(() => expect(ops()).toContainEqual([{ kind: 'reorder', ids: ['b_bbbbbbbb', 'b_cccccccc', 'b_aaaaaaaa'] }]))
  })

  it('keeps the row target while crossing the gap between rows', async () => {
    render(BacklogView)
    const rows = await screen.findAllByTestId('backlog-item')
    const end = screen.getByTestId('backlog-drop-end')
    await fireEvent.dragStart(rows[2], { dataTransfer: new DataTransfer() })
    await fireEvent.dragOver(rows[0], { dataTransfer: new DataTransfer() })
    await fireEvent.dragOver(rows[0].parentElement!, { dataTransfer: new DataTransfer() })
    expect(end.className).not.toContain('border-blue-500')
    await fireEvent.drop(rows[0].parentElement!, { dataTransfer: new DataTransfer() })
    await waitFor(() => expect(ops()).toContainEqual([{ kind: 'reorder', ids: ['b_cccccccc', 'b_aaaaaaaa', 'b_bbbbbbbb'] }]))
  })
})

describe('drafts', () => {
  const KEY = `simpleedit:backlog-draft:${P}\nb_aaaaaaaa`

  /** A reload: the store starts over from main and this viewer's storage. */
  async function reload(): Promise<void> {
    const kept = Object.entries(localStorage).filter(([k]) => k.startsWith('simpleedit:backlog-draft'))
    _resetBacklogForTests()
    for (const [k, v] of kept) localStorage.setItem(k, v)
    await backlogStore.load()
  }

  function draftOf(prompt: string, over: Partial<BacklogDraft> = {}): BacklogDraft {
    return { prompt, label: '', target: '', saved: { prompt: '', label: '', target: '' }, baseVersion: 0, created: false, ...over }
  }

  function deferred(): { promise: Promise<BacklogOpResult>; resolve: (r: BacklogOpResult) => void; reject: (e: Error) => void } {
    let resolve!: (r: BacklogOpResult) => void
    let reject!: (e: Error) => void
    const promise = new Promise<BacklogOpResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('keeps typing in storage until main has it, and restores it after a reload', async () => {
    onOp = () => {
      throw new Error('socket closed')
    }
    const view = render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'survives a reload' } })
    await waitFor(() => expect(localStorage.getItem(KEY)).toContain('survives a reload'))
    view.unmount()
    await reload()
    onOp = applyLikeMain
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toBe('survives a reload'))
    await waitFor(() => expect(backlogStore.get('b_aaaaaaaa')?.prompt).toBe('survives a reload'), { timeout: 2000 })
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
  })

  it('keeps text held by a conflict over a reload, and shows the conflict again', async () => {
    const theirs = item('b_aaaaaaaa', { prompt: 'their text', version: 2 })
    onOp = () => ({ ok: false, conflict: { id: 'b_aaaaaaaa', current: theirs }, snapshot: snapshot(backlogStore.items) })
    const view = render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'mine' } })
    expect(await screen.findByText(/changed somewhere else/, undefined, { timeout: 2000 })).toBeTruthy()
    window.dispatchEvent(new Event('beforeunload'))
    view.unmount()
    invoke.mockImplementation(async (channel: string, arg: unknown) =>
      channel === 'backlog:load' ? { project: P, items: [theirs, item('b_bbbbbbbb')], rev: 1 } : answer(channel, arg),
    )
    await reload()
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toBe('mine'))
    expect(await screen.findByText(/changed somewhere else/, undefined, { timeout: 2000 })).toBeTruthy()
  })

  it('lists a draft whose item left the backlog, to save as new or discard', async () => {
    onOp = () => {
      throw new Error('socket closed')
    }
    const view = render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'orphaned text' } })
    view.unmount()
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull())
    put([item('b_bbbbbbbb'), item('b_cccccccc')])
    backlogStore.select('b_bbbbbbbb')
    render(BacklogView)
    const row = await screen.findByTestId('backlog-draft')
    expect(row.textContent).toContain('Unsaved draft')
    await fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(prompt().value).toBe('orphaned text'))
    await fireEvent.click(await screen.findByRole('button', { name: 'Discard' }, { timeout: 2000 }))
    await waitFor(() => expect(screen.queryByTestId('backlog-draft')).toBeNull())
    expect(backlogStore.draft('b_aaaaaaaa')).toBeUndefined()
    await waitFor(() => expect(backlogStore.selectedId).toBe('b_bbbbbbbb'))
  })

  it("never lets a closed editor's late save overwrite newer typing, or conflict with it", async () => {
    const first = deferred()
    let calls = 0
    onOp = (batch) => (++calls === 1 ? first.promise.then(() => applyLikeMain(batch)) : applyLikeMain(batch))
    const view = render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'older' } })
    view.unmount()
    expect(ops()).toHaveLength(1)
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toBe('older'))
    await fireEvent.input(prompt(), { target: { value: 'newer' } })
    await new Promise((r) => setTimeout(r, 800))
    // Queued behind the first save.
    expect(ops()).toHaveLength(1)
    first.resolve({ ok: true, snapshot: snapshot(backlogStore.items) })
    await waitFor(() => expect(ops()).toHaveLength(2))
    expect(ops()[1]).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 2, patch: { prompt: 'newer' } }])
    await waitFor(() => expect(backlogStore.get('b_aaaaaaaa')?.prompt).toBe('newer'))
    expect(screen.queryByText(/changed somewhere else/)).toBeNull()
    expect(prompt().value).toBe('newer')
    await waitFor(() => expect(backlogStore.draft('b_aaaaaaaa')).toBeUndefined())
  })

  it("keeps the newer draft when a closed editor's save fails late", async () => {
    const first = deferred()
    let calls = 0
    onOp = (batch) => (++calls === 1 ? first.promise : applyLikeMain(batch))
    const view = render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.input(prompt(), { target: { value: 'older' } })
    view.unmount()
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toBe('older'))
    await fireEvent.input(prompt(), { target: { value: 'newer' } })
    first.reject(new Error('socket closed'))
    await waitFor(() => expect(ops()).toHaveLength(2), { timeout: 2000 })
    expect(ops()[1]).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 1, patch: { prompt: 'newer' } }])
    expect(prompt().value).toBe('newer')
  })

  it("writes each draft under its own key, and picks up another window's", async () => {
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    // Another window on this project keeps a draft of b; ours must not erase it.
    const otherKey = `simpleedit:backlog-draft:${P}\nb_bbbbbbbb`
    const other = JSON.stringify(draftOf('from the other window', { created: true, baseVersion: 1, saved: { prompt: 'Do the b_bbbbbbbb work\nwith details', label: 'Item b_bbbbbbbb', target: '' } }))
    localStorage.setItem(otherKey, other)
    window.dispatchEvent(new StorageEvent('storage', { key: otherKey, newValue: other }))
    await waitFor(() => expect(backlogStore.draft('b_bbbbbbbb')?.prompt).toBe('from the other window'))
    onOp = () => {
      throw new Error('socket closed')
    }
    await fireEvent.input(prompt(), { target: { value: 'ours' } })
    await waitFor(() => expect(localStorage.getItem(KEY)).toContain('ours'))
    expect(localStorage.getItem(otherKey)).toBe(other)
    expect(screen.getAllByText(/unsaved edits/)).toHaveLength(2)
    window.dispatchEvent(new StorageEvent('storage', { key: otherKey, newValue: null }))
    await waitFor(() => expect(backlogStore.draft('b_bbbbbbbb')).toBeUndefined())
  })

  it('Start on a row with unsaved text opens it and saves that text first', async () => {
    const order: string[] = []
    invoke.mockImplementation(async (channel: string, arg: unknown) => {
      if (channel === 'backlog:op' || channel === 'backlog:start') order.push(channel)
      return channel === 'backlog:start' ? { terminalId: 'agent-1', label: 'x' } : answer(channel, arg)
    })
    const select = vi.spyOn(sessionsStore, 'select').mockImplementation(() => {})
    backlogStore.putDraft('b_bbbbbbbb', draftOf('the newer text', { created: true, baseVersion: 1, saved: { prompt: 'Do the b_bbbbbbbb work\nwith details', label: 'Item b_bbbbbbbb', target: '' }, label: 'Item b_bbbbbbbb' }))
    render(BacklogView)
    await waitFor(() => expect(prompt().value).toContain('b_aaaaaaaa'))
    await fireEvent.click((await screen.findAllByRole('button', { name: 'Start' }))[1])
    await waitFor(() => expect(order).toEqual(['backlog:op', 'backlog:start']))
    expect(ops()[0]).toEqual([{ kind: 'update', id: 'b_bbbbbbbb', baseVersion: 1, patch: { prompt: 'the newer text' } }])
    expect(invoke).toHaveBeenCalledWith('backlog:start', expect.objectContaining({ id: 'b_bbbbbbbb' }))
    select.mockRestore()
  })

  it('drops the draft of an item it deletes', async () => {
    onOp = (batch) => {
      if (batch[0].kind !== 'remove') return applyLikeMain(batch)
      return { ok: true, snapshot: snapshot(backlogStore.items.filter((i) => i.id !== batch[0].id)) }
    }
    backlogStore.putDraft('b_bbbbbbbb', draftOf('doomed', { created: true, baseVersion: 1, saved: { prompt: 'x', label: '', target: '' } }))
    render(BacklogView)
    await fireEvent.click(await screen.findByRole('button', { name: 'Delete Item b_bbbbbbbb' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(backlogStore.items.map((i) => i.id)).not.toContain('b_bbbbbbbb'))
    expect(backlogStore.draft('b_bbbbbbbb')).toBeUndefined()
    expect(screen.queryByTestId('backlog-draft')).toBeNull()
  })

  it("opening a never-added draft doesn't add it, and offers Add it or Discard", async () => {
    backlogStore.putDraft('b_nnnnnnnn', draftOf('never added'))
    render(BacklogView)
    const row = await screen.findByTestId('backlog-draft')
    expect(row.textContent).toContain('Unsaved new item')
    await fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(prompt().value).toBe('never added'))
    expect(screen.getByText(/never added to the backlog/)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 800))
    expect(ops()).toEqual([])
    // Switching away doesn't add it either, and keeps it.
    await fireEvent.click(screen.getByText('Item b_cccccccc'))
    await waitFor(() => expect(prompt().value).toContain('b_cccccccc'))
    expect(ops()).toEqual([])
    expect(backlogStore.draft('b_nnnnnnnn')?.prompt).toBe('never added')
    await fireEvent.click(screen.getByTestId('backlog-draft').querySelector('button')!)
    await fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByTestId('backlog-draft')).toBeNull())
    expect(backlogStore.draft('b_nnnnnnnn')).toBeUndefined()
    expect(ops()).toEqual([])
  })

  it('Add it adds a never-added draft', async () => {
    backlogStore.putDraft('b_nnnnnnnn', draftOf('never added'))
    render(BacklogView)
    await fireEvent.click((await screen.findByTestId('backlog-draft')).querySelector('button')!)
    await fireEvent.click(await screen.findByRole('button', { name: 'Add it' }))
    await waitFor(() => expect(ops()).toEqual([[{ kind: 'add', item: { id: 'b_nnnnnnnn', prompt: 'never added' } }]]))
    await waitFor(() => expect(backlogStore.draft('b_nnnnnnnn')).toBeUndefined())
  })
})

describe('switching project', () => {
  it("forgets the old project's arrivals and selection", async () => {
    put([...backlogStore.items, item('b_dddddddd', { createdBy: 'agent' })])
    backlogStore.select('b_bbbbbbbb')
    expect(backlogStore.arrivals).toHaveLength(1)
    invoke.mockImplementation(async (channel: string, arg: unknown) =>
      channel === 'backlog:load' ? { project: '/repo/other.git', items: [], rev: 1 } : answer(channel, arg),
    )
    await backlogStore.load()
    expect(backlogStore.arrivals).toEqual([])
    expect(backlogStore.selectedId).toBeNull()
  })
})
