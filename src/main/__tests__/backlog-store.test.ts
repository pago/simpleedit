import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BacklogOp } from '../../shared/backlog'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { getDb, openDb, useDbForTests } from '../db'
import {
  BACKLOG_MAX_TOMBSTONES,
  _resetBacklogForTests,
  applyBacklogOps,
  loadBacklog,
  parseBacklogOps,
  recordStartIssue,
  removeStartedItem,
  reorderIds,
  setStarting,
} from '../backlog-store'

const P = '/repo/project.git'
const OTHER = '/repo/other.git'
const desk = { createdBy: 'desktop' } as const

function add(id: string, prompt = `do ${id}`, index?: number): BacklogOp {
  return { kind: 'add', item: { id, prompt }, ...(index !== undefined ? { index } : {}) }
}

function ids(project = P): string[] {
  return loadBacklog(project).items.map((i) => i.id)
}

beforeEach(() => {
  useDbForTests(openDb(':memory:'))
  _resetBacklogForTests()
})

describe('backlog store', () => {
  it('adds at the end or at an index, per project', () => {
    applyBacklogOps(P, [add('b_aaaaaaaa'), add('b_bbbbbbbb')], desk)
    applyBacklogOps(P, [add('b_cccccccc', 'first', 0)], desk)
    applyBacklogOps(OTHER, [add('b_dddddddd')], desk)
    expect(ids()).toEqual(['b_cccccccc', 'b_aaaaaaaa', 'b_bbbbbbbb'])
    expect(ids(OTHER)).toEqual(['b_dddddddd'])
    expect(loadBacklog(P).items[0]).toMatchObject({ prompt: 'first', version: 1, createdBy: 'desktop' })
  })

  it('records who added an item', () => {
    applyBacklogOps(P, [add('b_aaaaaaaa')], { createdBy: 'agent', createdBySession: 'parser rewrite' })
    expect(loadBacklog(P).items[0]).toMatchObject({ createdBy: 'agent', createdBySession: 'parser rewrite' })
  })

  it('reorders listed ids first and keeps the rest in their order', () => {
    applyBacklogOps(P, ['a', 'b', 'c', 'd'].map((x) => add(`b_${x.repeat(8)}`)), desk)
    applyBacklogOps(P, [{ kind: 'reorder', ids: ['b_dddddddd', 'b_zzzzzzzz', 'b_bbbbbbbb'] }], desk)
    expect(ids()).toEqual(['b_dddddddd', 'b_bbbbbbbb', 'b_aaaaaaaa', 'b_cccccccc'])
  })

  it('keeps an item added since the reorder was made', () => {
    expect(reorderIds(['x', 'y', 'new'], ['y', 'x'])).toEqual(['y', 'x', 'new'])
  })

  it('refuses a stale update and applies nothing in its batch', () => {
    applyBacklogOps(P, [add('b_aaaaaaaa'), add('b_bbbbbbbb')], desk)
    applyBacklogOps(P, [{ kind: 'update', id: 'b_aaaaaaaa', patch: { prompt: 'phone edit' } }], desk)
    const { result, changed } = applyBacklogOps(
      P,
      [
        { kind: 'remove', id: 'b_bbbbbbbb' },
        { kind: 'update', id: 'b_aaaaaaaa', baseVersion: 1, patch: { prompt: 'desk edit' } },
      ],
      desk,
    )
    expect(changed).toBe(false)
    expect(result).toMatchObject({ ok: false, conflict: { id: 'b_aaaaaaaa', current: { prompt: 'phone edit', version: 2 } } })
    expect(ids()).toEqual(['b_aaaaaaaa', 'b_bbbbbbbb'])
  })

  it('reports an update for an item that is gone as a conflict with nothing current', () => {
    const { result } = applyBacklogOps(P, [{ kind: 'update', id: 'b_aaaaaaaa', patch: { prompt: 'x' } }], desk)
    expect(result).toMatchObject({ ok: false, conflict: { id: 'b_aaaaaaaa', current: null } })
  })

  it('clears optional fields with null, and a start issue on any edit', () => {
    applyBacklogOps(
      P,
      [{ kind: 'add', item: { id: 'b_aaaaaaaa', prompt: 'p', label: 'L', target: { provider: 'codex', model: 'gpt-5.5' } } }],
      desk,
    )
    recordStartIssue(P, 'b_aaaaaaaa', { outcome: 'failed', reason: 'no codex', at: 'now' })
    applyBacklogOps(P, [{ kind: 'update', id: 'b_aaaaaaaa', patch: { label: null, target: null } }], desk)
    const item = loadBacklog(P).items[0]
    expect(item.label).toBeUndefined()
    expect(item.target).toBeUndefined()
    expect(item.lastStart).toBeUndefined()
    expect(item.version).toBe(2)
  })

  it('treats an op that changes nothing as no change', () => {
    applyBacklogOps(P, [add('b_aaaaaaaa')], desk)
    const before = loadBacklog(P).rev
    const { changed } = applyBacklogOps(
      P,
      [
        { kind: 'update', id: 'b_aaaaaaaa', patch: { prompt: 'do b_aaaaaaaa' } },
        { kind: 'reorder', ids: ['b_aaaaaaaa'] },
        { kind: 'remove', id: 'b_zzzzzzzz' },
      ],
      desk,
    )
    expect(changed).toBe(false)
    expect(loadBacklog(P).rev).toBe(before)
  })

  it('drops a replayed add of an item that was removed or started', () => {
    applyBacklogOps(P, [add('b_aaaaaaaa'), add('b_bbbbbbbb')], desk)
    applyBacklogOps(P, [{ kind: 'remove', id: 'b_aaaaaaaa' }], desk)
    removeStartedItem(P, 'b_bbbbbbbb')
    const { changed } = applyBacklogOps(P, [add('b_aaaaaaaa'), add('b_bbbbbbbb')], desk)
    expect(changed).toBe(false)
    expect(ids()).toEqual([])
  })

  it('refuses edits and removal while an item is starting', () => {
    applyBacklogOps(P, [add('b_aaaaaaaa')], desk)
    setStarting('b_aaaaaaaa', true)
    expect(loadBacklog(P).items[0].starting).toBe(true)
    expect(applyBacklogOps(P, [{ kind: 'remove', id: 'b_aaaaaaaa' }], desk).result.ok).toBe(false)
    expect(applyBacklogOps(P, [{ kind: 'update', id: 'b_aaaaaaaa', patch: { prompt: 'x' } }], desk).result.ok).toBe(false)
    setStarting('b_aaaaaaaa', false)
    expect(applyBacklogOps(P, [{ kind: 'remove', id: 'b_aaaaaaaa' }], desk).result.ok).toBe(true)
  })

  it('raises rev on every change', () => {
    const r0 = loadBacklog(P).rev
    applyBacklogOps(P, [add('b_aaaaaaaa')], desk)
    const r1 = loadBacklog(P).rev
    recordStartIssue(P, 'b_aaaaaaaa', { outcome: 'unconfirmed', reason: 'x', at: 'now' })
    expect(r1).toBeGreaterThan(r0)
    expect(loadBacklog(P).rev).toBeGreaterThan(r1)
  })
})

describe('tombstones', () => {
  it('keeps only the newest per project', () => {
    const total = BACKLOG_MAX_TOMBSTONES + 3
    for (let n = 0; n < total; n++) {
      const id = `b_${String(n).padStart(8, '0')}`
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, n))
      applyBacklogOps(P, [add(id)], desk, at)
      applyBacklogOps(P, [{ kind: 'remove', id }], desk, at)
    }
    applyBacklogOps(OTHER, [add('b_zzzzzzzz'), { kind: 'remove', id: 'b_zzzzzzzz' }], desk)
    const count = (project: string): number =>
      (getDb().prepare('SELECT COUNT(*) AS n FROM backlog_tombstones WHERE project = ?').get(project) as { n: number }).n
    expect(count(P)).toBe(BACKLOG_MAX_TOMBSTONES)
    expect(count(OTHER)).toBe(1)
    // The newest still stops a retried add; the oldest no longer needs to.
    applyBacklogOps(P, [add(`b_${String(total - 1).padStart(8, '0')}`), add('b_00000000')], desk)
    expect(ids()).toEqual(['b_00000000'])
  })
})

describe('title or prompt', () => {
  it('adds a title-only item', () => {
    applyBacklogOps(P, parseBacklogOps([{ kind: 'add', item: { id: 'b_aaaaaaaa', prompt: '', label: 'later' } }]), desk)
    expect(loadBacklog(P).items[0]).toMatchObject({ id: 'b_aaaaaaaa', prompt: '', label: 'later' })
  })

  it('refuses an update that would leave neither, and applies nothing in its batch', () => {
    applyBacklogOps(P, [{ kind: 'add', item: { id: 'b_aaaaaaaa', prompt: '', label: 'title only' } }, add('b_bbbbbbbb')], desk)
    const clearTitle = parseBacklogOps([
      { kind: 'update', id: 'b_bbbbbbbb', patch: { prompt: 'changed' } },
      { kind: 'update', id: 'b_aaaaaaaa', patch: { label: null } },
    ])
    expect(() => applyBacklogOps(P, clearTitle, desk)).toThrow(/needs a title or a prompt/)
    expect(loadBacklog(P).items.map((i) => i.prompt)).toEqual(['', 'do b_bbbbbbbb'])

    expect(() => applyBacklogOps(P, parseBacklogOps([{ kind: 'update', id: 'b_bbbbbbbb', patch: { prompt: ' ' } }]), desk)).toThrow(
      /needs a title or a prompt/,
    )
    // Clearing one side is fine while the other remains.
    applyBacklogOps(P, parseBacklogOps([{ kind: 'update', id: 'b_aaaaaaaa', patch: { prompt: 'now a prompt' } }]), desk)
    applyBacklogOps(P, parseBacklogOps([{ kind: 'update', id: 'b_aaaaaaaa', patch: { label: null } }]), desk)
    expect(loadBacklog(P).items[0]).toMatchObject({ prompt: 'now a prompt' })
    expect(loadBacklog(P).items[0].label).toBeUndefined()
  })
})

describe('parseBacklogOps', () => {
  it('rebuilds ops from known fields only', () => {
    const [op] = parseBacklogOps([{ kind: 'add', item: { id: 'b_aaaaaaaa', prompt: 'p', extra: 1 }, junk: true }])
    expect(op).toEqual({ kind: 'add', item: { id: 'b_aaaaaaaa', prompt: 'p' } })
  })

  it('refuses an item with neither title nor prompt, one over the session cap, and a malformed id', () => {
    expect(() => parseBacklogOps([{ kind: 'add', item: { id: 'b_aaaaaaaa', prompt: '  ' } }])).toThrow(/needs a title or a prompt/)
    expect(() => parseBacklogOps([{ kind: 'add', item: { id: 'b_aaaaaaaa', prompt: '', label: ' \n ' } }])).toThrow(/needs a title or a prompt/)
    expect(() => parseBacklogOps([{ kind: 'add', item: { id: 'b_aaaaaaaa', label: 'x' } }])).toThrow(/must be text/)
    expect(() => parseBacklogOps([{ kind: 'add', item: { id: 'b_aaaaaaaa', prompt: 'x'.repeat(32_001) } }])).toThrow(/limit is 32000/)
    expect(() => parseBacklogOps([{ kind: 'remove', id: '../etc' }])).toThrow(/Malformed/)
  })

  it('refuses an unknown agent and an empty or oversized batch', () => {
    expect(() =>
      parseBacklogOps([{ kind: 'add', item: { id: 'b_aaaaaaaa', prompt: 'p', target: { provider: 'bash' } } }]),
    ).toThrow(/can't start that agent/)
    expect(() => parseBacklogOps([])).toThrow(/at least one/)
    expect(() => parseBacklogOps(Array.from({ length: 51 }, () => ({ kind: 'remove', id: 'b_aaaaaaaa' })))).toThrow(/at most 50/)
  })

  it('keeps a prompt verbatim', () => {
    const prompt = '  Use @src/a.ts and $HOME as written\n'
    const [op] = parseBacklogOps([{ kind: 'add', item: { id: 'b_aaaaaaaa', prompt } }])
    expect(op.kind === 'add' && op.item.prompt).toBe(prompt)
  })
})

describe('targets', () => {
  it('drops a reasoning effort, on add and on update', () => {
    const [add, update] = parseBacklogOps([
      { kind: 'add', item: { id: 'b_aaaaaaaa', prompt: 'p', target: { provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' } } },
      { kind: 'update', id: 'b_aaaaaaaa', patch: { target: { provider: 'opencode', reasoningEffort: 'low' } } },
    ])
    expect(add.kind === 'add' && add.item.target).toEqual({ provider: 'codex', model: 'gpt-5.5' })
    expect(update.kind === 'update' && update.patch.target).toEqual({ provider: 'opencode' })
  })

  it('ignores a worktree', () => {
    const [op] = parseBacklogOps([{ kind: 'add', item: { id: 'b_aaaaaaaa', prompt: 'p', worktree: '/repo/feature' } }])
    expect(op).toEqual({ kind: 'add', item: { id: 'b_aaaaaaaa', prompt: 'p' } })
  })
})
