import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_MAX_HISTORY,
  WorkflowValidationError,
  archiveAttempt,
  checkGraph,
  describeWorkflow,
  parseAttemptHistory,
  parseNewWorkflow,
  parseWorkflowOps,
  taskDepths,
  templateRefs,
  workflowProgress,
  type Workflow,
  type WorkflowSnapshot,
  type WorkflowTask,
} from '../workflow'
import { parseSessionOwner, workflowOwner } from '../session-owner'

function problemsOf(fn: () => unknown): string[] {
  try {
    fn()
  } catch (error) {
    if (error instanceof WorkflowValidationError) return error.problems
    throw error
  }
  throw new Error('expected a WorkflowValidationError')
}

const task = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Task ${id}`,
  brief: `Do ${id}`,
  ...extra,
})

describe('parseNewWorkflow', () => {
  it('fills defaults: kind agent, onFailure escalate, no after', () => {
    const wf = parseNewWorkflow({ title: ' T ', goal: 'G', tasks: [task('a')] })
    expect(wf.title).toBe('T')
    expect(wf.tasks).toEqual([{ id: 'a', title: 'Task a', kind: 'agent', after: [], brief: 'Do a', onFailure: 'escalate' }])
  })

  it('dedupes after and keeps optional fields', () => {
    const wf = parseNewWorkflow({
      title: 'T',
      goal: 'G',
      tasks: [
        task('a', { provider: 'codex', effort: 'high', model: 'gpt-5', worktree: { branch: 'feat/a', base: 'main' }, onFailure: 'retry' }),
        task('b', { after: ['a', 'a'], acceptance: 'tests pass' }),
      ],
    })
    expect(wf.tasks[0]).toMatchObject({ provider: 'codex', effort: 'high', model: 'gpt-5', worktree: { branch: 'feat/a', base: 'main' }, onFailure: 'retry' })
    expect(wf.tasks[1].after).toEqual(['a'])
    expect(wf.tasks[1].acceptance).toBe('tests pass')
  })

  it('lists every per-task problem together', () => {
    const problems = problemsOf(() =>
      parseNewWorkflow({
        title: '',
        goal: 'G',
        tasks: [
          task('i', { kind: 'integrate' }),
          task('e', { effort: 'high' }),
          task('BAD'),
          task('s', { shape: 'single' }),
          task('w', { worktree: { branch: '-x' } }),
        ],
      }),
    )
    expect(problems).toEqual(
      expect.arrayContaining([
        'title: must be a non-empty string',
        expect.stringContaining('tasks[0].shape'),
        expect.stringContaining('tasks[0].after: an integrate task'),
        'tasks[1].effort: only for provider "codex"',
        expect.stringContaining('tasks[2].id'),
        'tasks[3].shape: only for kind "integrate"',
        'tasks[4].worktree.branch: not a valid branch name',
      ]),
    )
    expect(problems.length).toBeGreaterThanOrEqual(7)
  })

  it('reports duplicate ids', () => {
    expect(problemsOf(() => parseNewWorkflow({ title: 'T', goal: 'G', tasks: [task('a'), task('a')] }))).toEqual(['tasks: id "a" is used twice'])
  })

  it('reports unknown after and self-reference', () => {
    const problems = problemsOf(() =>
      parseNewWorkflow({ title: 'T', goal: 'G', tasks: [task('a', { after: ['nope'] }), task('b', { after: ['b'] })] }),
    )
    expect(problems).toContain('task a: after names unknown task "nope"')
    expect(problems).toContain("task b: can't run after itself")
  })

  it('reports a cycle', () => {
    const problems = problemsOf(() =>
      parseNewWorkflow({ title: 'T', goal: 'G', tasks: [task('a', { after: ['c'] }), task('b', { after: ['a'] }), task('c', { after: ['b'] })] }),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^the tasks form a cycle: /)
    expect(problems[0]).toContain('a')
  })

  it('reports a bad template and a template naming a non-ancestor', () => {
    const problems = problemsOf(() =>
      parseNewWorkflow({
        title: 'T',
        goal: 'G',
        tasks: [
          task('a'),
          task('b', { brief: 'use {{task.a.result.secret}}' }),
          task('c', { brief: 'see {{task.a.result.summary}}' }),
          task('d', { after: ['a'], brief: 'see {{ task.a.result.branch }}' }),
        ],
      }),
    )
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('unknown template {{task.a.result.secret}}')
    expect(problems[1]).toBe('task c.brief: {{task.a…}} must name a task it runs after (directly or not)')
  })

  it('accepts a template naming a transitive ancestor', () => {
    expect(() =>
      parseNewWorkflow({ title: 'T', goal: 'G', tasks: [task('a'), task('b', { after: ['a'] }), task('c', { after: ['b'], brief: '{{task.a.result.items}}' })] }),
    ).not.toThrow()
  })

  it('refuses a non-object or an empty task list', () => {
    expect(problemsOf(() => parseNewWorkflow(null))).toEqual(['expected {title, goal, tasks}'])
    expect(problemsOf(() => parseNewWorkflow({ title: 'T', goal: 'G', tasks: [] }))).toEqual(['tasks: a non-empty list'])
  })
})

describe('templateRefs / checkGraph', () => {
  it('returns referenced ids', () => {
    const problems: string[] = []
    expect(templateRefs('{{task.a.result.summary}} and {{task.b-2.result.changedFiles}}', 'x', problems)).toEqual(['a', 'b-2'])
    expect(problems).toEqual([])
  })

  it('checkGraph pushes nothing for a valid graph', () => {
    const problems: string[] = []
    checkGraph(
      [
        { id: 'a', after: [], brief: 'x' },
        { id: 'b', after: ['a'], brief: '{{task.a.result.summary}}' },
      ],
      problems,
    )
    expect(problems).toEqual([])
  })
})

describe('parseWorkflowOps', () => {
  it('parses every op shape', () => {
    const ops = parseWorkflowOps([
      { op: 'add', task: task('n', { after: ['a'] }) },
      { op: 'update', id: 'a', patch: { title: 'New', acceptance: null, model: null, worktree: { branch: 'b' } } },
      { op: 'cancel', id: 'b' },
      { op: 'retry', id: 'c' },
      { op: 'retry', id: 'd', brief: 'again' },
    ])
    expect(ops).toEqual([
      { op: 'add', task: { id: 'n', title: 'Task n', kind: 'agent', after: ['a'], brief: 'Do n', onFailure: 'escalate' } },
      { op: 'update', id: 'a', patch: { title: 'New', acceptance: null, model: null, worktree: { branch: 'b' } } },
      { op: 'cancel', id: 'b' },
      { op: 'retry', id: 'c' },
      { op: 'retry', id: 'd', brief: 'again' },
    ])
  })

  it('collects problems across ops', () => {
    const problems = problemsOf(() =>
      parseWorkflowOps([
        { op: 'nope', id: 'a' },
        { op: 'update', id: 'a', patch: { state: 'done', onFailure: 'never' } },
        { op: 'cancel', id: 'Bad Id' },
        { op: 'retry', id: 'a', brief: '' },
      ]),
    )
    expect(problems).toEqual([
      'ops[0].op: "add", "update", "cancel" or "retry"',
      "ops[1].patch.state: can't be changed",
      'ops[1].patch.onFailure: "retry" or "escalate"',
      'ops[2].id: a task id',
      'ops[3].brief: must be a non-empty string',
    ])
  })

  it('refuses an empty or non-array list', () => {
    expect(problemsOf(() => parseWorkflowOps([]))).toEqual(['ops: a non-empty list'])
    expect(problemsOf(() => parseWorkflowOps({}))).toEqual(['ops: a non-empty list'])
  })
})

function wfTask(id: string, after: string[], extra: Partial<WorkflowTask> = {}): WorkflowTask {
  return { id, title: id, kind: 'agent', after, brief: 'x', onFailure: 'escalate', state: 'queued', attempt: 0, steered: false, ...extra }
}

describe('derived views', () => {
  it('taskDepths gives roots 0 and children 1 + deepest parent', () => {
    const depths = taskDepths([
      { id: 'a', after: [] },
      { id: 'b', after: ['a'] },
      { id: 'c', after: ['a', 'b'] },
      { id: 'd', after: ['missing'] },
    ])
    expect(Object.fromEntries(depths)).toEqual({ a: 0, b: 1, c: 2, d: 0 })
  })

  it('taskDepths terminates on a cycle', () => {
    const depths = taskDepths([
      { id: 'a', after: ['b'] },
      { id: 'b', after: ['a'] },
    ])
    expect(depths.size).toBe(2)
  })

  it('workflowProgress ignores cancelled tasks', () => {
    expect(
      workflowProgress({ tasks: [wfTask('a', [], { state: 'done' }), wfTask('b', [], { state: 'cancelled' }), wfTask('c', [])] }),
    ).toEqual({ done: 1, total: 2 })
  })

  it('describeWorkflow includes only what is set', () => {
    const workflow: Workflow = {
      id: 'wf_abcdef123',
      project: '/p.git',
      leadKey: 'lead',
      leadLabel: 'Lead',
      title: 'T',
      goal: 'G',
      version: 3,
      status: 'running',
      tasks: [
        wfTask('a', [], {
          state: 'done',
          attempt: 1,
          worktreePath: '/wt/a',
          result: { status: 'done', summary: 'did a', branch: 'feat-a', steered: true, at: 'now' },
        }),
        wfTask('b', ['a'], { state: 'failed', attempt: 2, note: 'broke', detached: true }),
      ],
      patches: [],
      judgments: [{ taskId: 'b', question: 'what now?', at: 'now', delivered: false }],
      createdAt: 'then',
    }
    const snapshot: WorkflowSnapshot = { workflow, paused: 'window-closed', workers: {} }
    expect(describeWorkflow(snapshot)).toEqual({
      workflowId: 'wf_abcdef123',
      title: 'T',
      status: 'running',
      version: 3,
      paused: 'window-closed',
      progress: { done: 1, total: 2 },
      tasks: [
        {
          id: 'a',
          kind: 'agent',
          state: 'done',
          after: [],
          worktree: '/wt/a',
          result: { status: 'done', summary: 'did a', branch: 'feat-a', steered: true },
        },
        { id: 'b', kind: 'agent', state: 'failed', after: ['a'], attempt: 2, note: 'broke', detached: true },
      ],
      openQuestions: [{ task: 'b', question: 'what now?' }],
    })
    const plain = describeWorkflow({ workflow: { ...workflow, judgments: [] }, paused: null, workers: {} })
    expect(plain).not.toHaveProperty('paused')
    expect(plain).not.toHaveProperty('openQuestions')
  })
})

describe('attempt history', () => {
  const result = { status: 'failed' as const, summary: 'broke', steered: false, at: 't' }

  it('archiveAttempt moves the result and note into a bounded history', () => {
    const task: WorkflowTask = { id: 'a', title: 'A', kind: 'agent', after: [], brief: 'b', onFailure: 'retry', state: 'failed', attempt: 1, steered: false, result, note: 'n' }
    archiveAttempt(task)
    expect(task).not.toHaveProperty('result')
    expect(task).not.toHaveProperty('note')
    expect(task.history).toEqual([{ attempt: 1, result, note: 'n' }])
    for (let i = 2; i <= WORKFLOW_MAX_HISTORY + 2; i++) {
      Object.assign(task, { attempt: i, note: `n${i}` })
      archiveAttempt(task)
    }
    expect(task.history!.map((h) => h.attempt)).toEqual([3, 4, 5, 6, 7])
  })

  it('parseAttemptHistory drops records without the right shape', () => {
    expect(parseAttemptHistory('nope')).toEqual([])
    expect(parseAttemptHistory([{ attempt: 1, note: 'ok', result }, { attempt: 'x' }, null, { attempt: 2, result: { status: 'bad' } }])).toEqual([
      { attempt: 1, note: 'ok', result },
      { attempt: 2 },
    ])
  })
})

describe('parseSessionOwner', () => {
  it('accepts a review owner', () => {
    expect(parseSessionOwner({ kind: 'review', reviewId: 'r_review01' })).toEqual({ kind: 'review', reviewId: 'r_review01' })
  })

  it('accepts a valid workflow owner and drops extra keys', () => {
    const owner = parseSessionOwner({ kind: 'workflow', workflowId: 'wf_abcdef123', taskId: 'a', attempt: 2, extra: 1 })
    expect(owner).toEqual({ kind: 'workflow', workflowId: 'wf_abcdef123', taskId: 'a', attempt: 2 })
    expect(workflowOwner({ owner })).toEqual(owner)
    expect(workflowOwner({ owner: { kind: 'review', reviewId: 'r_review01' } })).toBeUndefined()
  })

  it.each([
    { kind: 'workflow', workflowId: 'bad', taskId: 'a', attempt: 1 },
    { kind: 'workflow', workflowId: 'wf_abcdef123', taskId: 'A B', attempt: 1 },
    { kind: 'workflow', workflowId: 'wf_abcdef123', taskId: 'a', attempt: 0 },
    { kind: 'workflow', workflowId: 'wf_abcdef123', taskId: 'a', attempt: 1.5 },
    { kind: 'workflow', workflowId: 'wf_abcdef123', taskId: 'a', attempt: '1' },
    { kind: 'workflow', workflowId: 'wf_abcdef123', taskId: 'a' },
    { kind: 'other' },
    [],
    null,
  ])('refuses %j', (value) => {
    expect(parseSessionOwner(value)).toBeUndefined()
  })
})
