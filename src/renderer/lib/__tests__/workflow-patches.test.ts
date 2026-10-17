import { describe, it, expect } from 'vitest'
import type { WorkflowOp, WorkflowPatch, WorkflowTask } from '../../../shared/workflow'
import { patchAge, patchRows } from '../workflow-patches'

function task(id: string, extra: Partial<WorkflowTask> = {}): WorkflowTask {
  return { id, title: `Task ${id}`, kind: 'agent', after: [], brief: `Do ${id}`, onFailure: 'escalate', state: 'queued', attempt: 0, steered: false, ...extra }
}

function patch(version: number, ops: WorkflowOp[]): WorkflowPatch {
  return { version, at: `2026-10-16T00:0${version}:00.000Z`, ops }
}

function texts(ops: WorkflowOp[], tasks: WorkflowTask[] = []): string[] {
  return patchRows({ patches: [patch(2, ops)], tasks })[0].ops.map((o) => `${o.icon} ${o.text}`)
}

describe('patchRows', () => {
  it('numbers each patch by version − 1 and lists the newest first', () => {
    const rows = patchRows({ patches: [patch(2, [{ op: 'cancel', id: 'a' }]), patch(4, [{ op: 'cancel', id: 'c' }]), patch(3, [{ op: 'cancel', id: 'b' }])], tasks: [] })
    expect(rows.map((r) => [r.number, r.version])).toEqual([
      [3, 4],
      [2, 3],
      [1, 2],
    ])
    expect(rows[0].at).toBe('2026-10-16T00:04:00.000Z')
  })

  it('is empty without patches', () => {
    expect(patchRows({ patches: [], tasks: [task('a')] })).toEqual([])
  })

  it('describes an add with the current title, id and kind', () => {
    const spec = { id: 'fix', title: 'Spec title', kind: 'loop' as const, after: [], brief: 'b', onFailure: 'escalate' as const }
    expect(texts([{ op: 'add', task: spec }], [task('fix', { title: 'Renamed later', kind: 'loop' })])).toEqual(['＋ added Renamed later (fix, loop)'])
    expect(texts([{ op: 'add', task: spec }])).toEqual(['＋ added Spec title (fix, loop)'])
  })

  it('describes an update by its changed keys', () => {
    expect(texts([{ op: 'update', id: 'a', patch: { brief: 'x', model: null } }])).toEqual(['✎ a: brief, model'])
  })

  it('describes cancel, retry, extend and accept', () => {
    expect(
      texts([
        { op: 'cancel', id: 'a' },
        { op: 'retry', id: 'b' },
        { op: 'retry', id: 'c', brief: 'Try again' },
        { op: 'extend', id: 'd', rounds: 2 },
        { op: 'extend', id: 'd', rounds: 1 },
        { op: 'accept', id: 'e', summary: 'Good enough' },
      ]),
    ).toEqual(['✕ cancelled a', '↻ retried b', '↻ retried c with a new brief', '⇡ d: +2 rounds', '⇡ d: +1 round', '✓ accepted e as is'])
  })

  it('collects the touched task ids once per patch, unknown ones included', () => {
    const [row] = patchRows({
      patches: [patch(2, [{ op: 'update', id: 'a', patch: { title: 'x' } }, { op: 'retry', id: 'a' }, { op: 'cancel', id: 'gone' }])],
      tasks: [task('a')],
    })
    expect(row.taskIds).toEqual(['a', 'gone'])
    expect(row.ops.map((o) => o.taskIds)).toEqual([['a'], ['a'], ['gone']])
    expect(row.ops[2].text).toBe('cancelled gone')
  })
})

describe('patchAge', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  it('is coarse', () => {
    expect(patchAge('2026-10-16T11:59:30Z', now)).toBe('just now')
    expect(patchAge('2026-10-16T11:30:00Z', now)).toBe('30m ago')
    expect(patchAge('2026-10-16T09:00:00Z', now)).toBe('3h ago')
    expect(patchAge('2026-10-14T12:00:00Z', now)).toBe('2d ago')
    expect(patchAge('nope', now)).toBe('')
  })
})
