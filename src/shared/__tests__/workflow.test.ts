import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_MAX_HISTORY,
  childBranch,
  childTitle,
  childrenOf,
  currentSlots,
  detachedSlot,
  isSpecTaskId,
  isWorkflowTaskId,
  kindProblems,
  loopItems,
  loopPhase,
  ownerIsCurrent,
  parseLoopRounds,
  slotKey,
  waitingSlot,
  type WorkflowLoopRound,
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
      'ops[0].op: "add", "update", "cancel", "retry", "extend" or "accept"',
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
    const snapshot: WorkflowSnapshot = { workflow, paused: 'window-closed', workers: {}, reviewers: {} }
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
    const plain = describeWorkflow({ workflow: { ...workflow, judgments: [] }, paused: null, workers: {}, reviewers: {} })
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

const loopTask = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  task(id, { kind: 'loop', reviewer: { brief: 'Review it' }, worktree: { branch: `feat/${id}` }, ...extra })
const mapTask = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  task(id, { kind: 'map', after: ['src'], over: 'src.result.items', brief: 'Fix {{item}} ({{index}})', worktree: { branch: `${id}/{{index}}` }, ...extra })

describe('loop and map kinds', () => {
  it('fills a loop and a map default cap', () => {
    const wf = parseNewWorkflow({ title: 'T', goal: 'G', tasks: [task('src'), loopTask('l'), mapTask('m', { worktree: { branch: 'fix/{{index}}-{{item}}' } })] })
    expect(wf.tasks[1]).toEqual({
      id: 'l',
      title: 'Task l',
      kind: 'loop',
      after: [],
      brief: 'Do l',
      worktree: { branch: 'feat/l' },
      onFailure: 'escalate',
      reviewer: { brief: 'Review it' },
      maxRounds: 3,
    })
    expect(wf.tasks[2]).toMatchObject({ kind: 'map', over: 'src.result.items', maxItems: 20, worktree: { branch: 'fix/{{index}}-{{item}}' } })
  })

  it('keeps a reviewer agent spec and explicit caps', () => {
    const wf = parseNewWorkflow({
      title: 'T',
      goal: 'G',
      tasks: [task('src'), loopTask('l', { maxRounds: 5, reviewer: { brief: 'R', provider: 'codex', model: 'gpt-5', effort: 'high' } }), mapTask('m', { maxItems: 4 })],
    })
    expect(wf.tasks[1]).toMatchObject({ maxRounds: 5, reviewer: { brief: 'R', provider: 'codex', model: 'gpt-5', effort: 'high' } })
    expect(wf.tasks[2]).toMatchObject({ maxItems: 4 })
  })

  it('refuses a loop without reviewer or worktree and out-of-range caps', () => {
    const problems = problemsOf(() =>
      parseNewWorkflow({
        title: 'T',
        goal: 'G',
        tasks: [
          task('a', { kind: 'loop' }),
          loopTask('b', { maxRounds: 6, reviewer: { brief: 'R', effort: 'high' } }),
          task('c', { kind: 'map' }),
          mapTask('d', { maxItems: 21, over: 'src.result.summary' }),
          task('e', { kind: 'later' }),
        ],
      }),
    )
    expect(problems).toEqual([
      'tasks[0].reviewer: a review loop needs a reviewer {brief, provider?, model?, effort?}',
      "tasks[0].worktree: a review loop needs its own branch: the reviewer reviews that branch's diff",
      'tasks[1].reviewer.effort: only for provider "codex"',
      'tasks[1].maxRounds: a whole number from 1 to 5',
      'tasks[2].over: a map fans out over "<taskId>.result.items"; name that task',
      'tasks[2].worktree: a map needs a branch with {{index}} or {{item}}: its children write in parallel',
      'tasks[3].over: "<taskId>.result.items", the task whose items the map fans out over',
      'tasks[3].maxItems: a whole number from 1 to 20',
      'tasks[4].kind: "agent", "integrate", "loop" or "map"',
    ])
  })

  it('refuses kind fields on the wrong kind', () => {
    const problems = problemsOf(() =>
      parseNewWorkflow({
        title: 'T',
        goal: 'G',
        tasks: [task('a', { reviewer: { brief: 'R' }, maxRounds: 2, over: 'b.result.items', maxItems: 3, worktree: { branch: 'x/{{item}}' } }), loopTask('b', { shape: 'single' })],
      }),
    )
    expect(problems).toEqual([
      'tasks[0].reviewer: only for kind "loop"',
      'tasks[0].maxRounds: only for kind "loop"',
      'tasks[0].over: only for kind "map"',
      'tasks[0].maxItems: only for kind "map"',
      "tasks[0].worktree.branch: {{item}} only works in a map's brief, acceptance and worktree.branch",
      'tasks[1].shape: only for kind "integrate"',
    ])
  })

  it('needs a token in a map branch and a valid branch once filled in', () => {
    const problems = problemsOf(() =>
      parseNewWorkflow({
        title: 'T',
        goal: 'G',
        tasks: [task('src'), mapTask('a', { worktree: { branch: 'fix/all' } }), mapTask('b', { worktree: { branch: 'fix/{{item}}..x' } }), mapTask('c', { worktree: { branch: '{{other}}' } })],
      }),
    )
    expect(problems).toEqual([
      'tasks[1].worktree.branch: each child needs its own branch: put {{index}} or {{item}} in it',
      'tasks[2].worktree.branch: not a valid branch name',
      'tasks[3].worktree.branch: not a valid branch name',
    ])
  })

  it('allows {{item}} and {{index}} only in a map', () => {
    const problems = problemsOf(() =>
      parseNewWorkflow({
        title: 'T',
        goal: 'G',
        tasks: [
          task('src'),
          task('a', { brief: 'Do {{item}}' }),
          task('b', { acceptance: 'item {{ index }} works' }),
          loopTask('c', { reviewer: { brief: 'Check {{item}}' } }),
          mapTask('m', { acceptance: '{{item}} is fixed, see {{task.src.result.summary}}' }),
        ],
      }),
    )
    expect(problems).toEqual([
      "task a.brief: {{item}} only works in a map's brief, acceptance and worktree.branch",
      "task b.acceptance: {{index}} only works in a map's brief, acceptance and worktree.branch",
      "task c.reviewer.brief: {{item}} only works in a map's brief, acceptance and worktree.branch",
    ])
  })

  it("checks a reviewer brief's templates and a map's over against its ancestors", () => {
    const problems = problemsOf(() =>
      parseNewWorkflow({
        title: 'T',
        goal: 'G',
        tasks: [task('src'), loopTask('l', { reviewer: { brief: 'Compare with {{task.src.result.summary}}' } }), mapTask('m', { after: [] }), mapTask('self', { over: 'self.result.items' })],
      }),
    )
    expect(problems).toEqual([
      'task l.reviewer.brief: {{task.src…}} must name a task it runs after (directly or not)',
      `task m.over: must name a task this map runs after ("src" isn't one)`,
      `task self.over: must name a task this map runs after ("self" isn't one)`,
    ])
  })

  it('refuses child ids as a task id or in after', () => {
    const problems = problemsOf(() => parseNewWorkflow({ title: 'T', goal: 'G', tasks: [task('m.1'), task('b', { after: ['m.2'] })] }))
    expect(problems).toEqual([
      'tasks[0].id: lower-case letters, digits, - and _, at most 40',
      'tasks[1].after: "m.2" is a map\'s child; depend on the map "m" (its children exist only at runtime)',
    ])
    expect(isWorkflowTaskId('m.1')).toBe(true)
    expect(isWorkflowTaskId('m.0')).toBe(false)
    expect(isWorkflowTaskId('m.100')).toBe(false)
    expect(isSpecTaskId('m.1')).toBe(false)
  })

  it('checkGraph skips map children', () => {
    const problems: string[] = []
    checkGraph(
      [
        { id: 'src', after: [], brief: 'x' },
        { id: 'm', after: ['src'], brief: '{{item}}', kind: 'map', over: 'src.result.items' },
        { id: 'm.1', after: [], brief: 'resolved {{task.nope.result.summary}}', parent: 'm' },
      ],
      problems,
    )
    expect(problems).toEqual([])
  })

  it('kindProblems re-checks a patched task', () => {
    const problems: string[] = []
    kindProblems({ kind: 'loop', after: [], worktree: { branch: 'b' } }, 'ops[0]', problems)
    kindProblems({ kind: 'map', after: ['a'], over: 'a.result.items', worktree: { branch: 'b' } }, 'ops[1]', problems)
    expect(problems).toEqual([
      'ops[0].reviewer: a review loop needs a reviewer {brief, provider?, model?, effort?}',
      'ops[1].worktree.branch: each child needs its own branch: put {{index}} or {{item}} in it',
    ])
  })
})

describe('loop and map ops', () => {
  it('parses extend, accept, the new patch fields and child ids', () => {
    expect(
      parseWorkflowOps([
        { op: 'extend', id: 'l', rounds: 2 },
        { op: 'accept', id: 'l' },
        { op: 'accept', id: 'l', summary: ' good enough ' },
        { op: 'update', id: 'l', patch: { reviewer: { brief: 'R', provider: 'codex' }, maxRounds: 4 } },
        { op: 'update', id: 'm', patch: { over: 'x.result.items', maxItems: 5, worktree: { branch: 'f/{{index}}' } } },
        { op: 'retry', id: 'm.2' },
        { op: 'cancel', id: 'm.3' },
      ]),
    ).toEqual([
      { op: 'extend', id: 'l', rounds: 2 },
      { op: 'accept', id: 'l' },
      { op: 'accept', id: 'l', summary: 'good enough' },
      { op: 'update', id: 'l', patch: { reviewer: { brief: 'R', provider: 'codex' }, maxRounds: 4 } },
      { op: 'update', id: 'm', patch: { over: 'x.result.items', maxItems: 5, worktree: { branch: 'f/{{index}}' } } },
      { op: 'retry', id: 'm.2' },
      { op: 'cancel', id: 'm.3' },
    ])
  })

  it('refuses bad extend, accept and patch values', () => {
    expect(
      problemsOf(() =>
        parseWorkflowOps([
          { op: 'extend', id: 'l', rounds: 6 },
          { op: 'extend', id: 'l' },
          { op: 'accept', id: 'l', summary: '' },
          { op: 'update', id: 'l', patch: { reviewer: {}, maxRounds: 0, over: 'x', maxItems: 21, after: ['m.1'] } },
        ]),
      ),
    ).toEqual([
      'ops[0].rounds: a whole number from 1 to 5',
      'ops[1].rounds: a whole number from 1 to 5',
      'ops[2].summary: must be a non-empty string',
      'ops[3].patch.after: "m.1" is a map\'s child; depend on the map "m" (its children exist only at runtime)',
      'ops[3].patch.reviewer.brief: must be a non-empty string',
      'ops[3].patch.maxRounds: a whole number from 1 to 5',
      'ops[3].patch.over: "<taskId>.result.items", the task whose items the map fans out over',
      'ops[3].patch.maxItems: a whole number from 1 to 20',
    ])
  })
})

describe('childBranch / childTitle', () => {
  it('slugs the item into the pattern', () => {
    expect(childBranch('fix/{{index}}-{{item}}', 'Fix the Login Page!', 2, new Set())).toBe('fix/2-fix-the-login-page')
    expect(childBranch('fix/{{item}}', '..--Weird...name--', 1, new Set())).toBe('fix/weird.name')
    expect(childBranch('fix/{{item}}', 'x'.repeat(60), 1, new Set())).toBe(`fix/${'x'.repeat(40)}`)
    expect(childBranch('fix/{{item}}', '!!!', 3, new Set())).toBe('fix/item-3')
  })

  it('falls back to the bare pattern plus index when the result is invalid', () => {
    expect(childBranch('{{item}}', '@{', 4, new Set())).toBe('item-4')
    expect(childBranch(`${'a'.repeat(110)}/{{item}}`, 'long item name here', 5, new Set())).toBe(`${'a'.repeat(100)}-5`)
  })

  it('appends the index when the name is taken', () => {
    expect(childBranch('fix/{{item}}', 'Same', 2, new Set(['fix/same']))).toBe('fix/same-2')
    expect(childBranch('fix/{{item}}', 'Same', 2, new Set(['fix/same', 'fix/same-2']))).toBe('fix/same-2-2')
  })

  it('titles a child by its first line', () => {
    expect(childTitle('First\u0007 line\nsecond', 1)).toBe('First line')
    expect(childTitle('y'.repeat(100), 1)).toHaveLength(80)
    expect(childTitle('\n', 3)).toBe('Item 3')
  })
})

function round(n: number, extra: Partial<WorkflowLoopRound> = {}): WorkflowLoopRound {
  return { round: n, review: 'pending', ...extra }
}

describe('task slots', () => {
  const loop = (extra: Partial<WorkflowTask>): WorkflowTask => wfTask('l', [], { kind: 'loop', attempt: 2, state: 'running', ...extra })

  it('lists the worker and a reviewing loop reviewer', () => {
    expect(currentSlots(wfTask('a', [], { attempt: 0 }))).toEqual([])
    expect(currentSlots(wfTask('a', [], { attempt: 1, state: 'running' }))).toEqual([{ taskId: 'a', attempt: 1 }])
    expect(currentSlots(wfTask('a', [], { attempt: 1, state: 'done' }))).toEqual([])
    expect(currentSlots(loop({ rounds: [round(1, { review: 'running', reviewer: 1 })], reviewers: 1 }))).toEqual([
      { taskId: 'l', attempt: 2 },
      { taskId: 'l', attempt: 2, review: 1 },
    ])
    expect(currentSlots(loop({ rounds: [round(1, { review: 'done', reviewer: 1 }), round(2)], reviewers: 1 }))).toEqual([{ taskId: 'l', attempt: 2 }])
    expect(currentSlots(loop({ state: 'failed', rounds: [round(1, { review: 'failed', reviewer: 1 })], reviewers: 1 }))).toEqual([{ taskId: 'l', attempt: 2 }])
    expect(currentSlots(loop({ state: 'failed', rounds: [round(1)] }))).toEqual([])
  })

  it('ownerIsCurrent matches the attempt and the latest reviewer, whatever the state', () => {
    const t = loop({ state: 'done', rounds: [round(1, { review: 'done', reviewer: 2 })], reviewers: 2 })
    expect(ownerIsCurrent(t, { taskId: 'l', attempt: 2 })).toBe(true)
    expect(ownerIsCurrent(t, { taskId: 'l', attempt: 2, review: 2 })).toBe(true)
    expect(ownerIsCurrent(t, { taskId: 'l', attempt: 2, review: 1 })).toBe(false)
    expect(ownerIsCurrent(t, { taskId: 'l', attempt: 1 })).toBe(false)
    expect(ownerIsCurrent(t, { taskId: 'x', attempt: 2 })).toBe(false)
    expect(ownerIsCurrent(wfTask('a', [], { attempt: 1 }), { taskId: 'a', attempt: 1, review: 1 })).toBe(false)
  })

  it('slotKey tells a reviewer from its worker', () => {
    expect(slotKey('wf_x', { taskId: 'l', attempt: 3 })).toBe('wf_x/l#3')
    expect(slotKey('wf_x', { taskId: 'l', attempt: 3, review: 2 })).toBe('wf_x/l#3/r2')
  })

  it('waitingSlot and loopPhase follow the current round', () => {
    expect(waitingSlot(wfTask('a', [], { state: 'running' }))).toBeNull()
    expect(waitingSlot(wfTask('a', [], { state: 'waiting' }))).toBe('worker')
    expect(waitingSlot(loop({ state: 'waiting', rounds: [round(1)] }))).toBe('worker')
    expect(waitingSlot(loop({ state: 'waiting', rounds: [round(1, { review: 'waiting', reviewer: 1 })] }))).toBe('reviewer')
    expect(waitingSlot(loop({ state: 'waiting', rounds: [round(1, { review: 'done', verdict: 'findings' })] }))).toBeNull()
    expect(loopPhase({})).toBeNull()
    expect(loopPhase({ rounds: [round(1)] })).toBe('working')
    expect(loopPhase({ rounds: [round(1, { review: 'queued' })] })).toBe('reviewing')
    expect(loopPhase({ rounds: [round(1, { review: 'failed' })] })).toBe('reviewer-failed')
    expect(loopPhase({ rounds: [round(1, { review: 'done', verdict: 'findings' })] })).toBe('not-converged')
    expect(loopPhase({ rounds: [round(1, { review: 'done', verdict: 'clean' })] })).toBe('clean')
  })

  it('archiveAttempt records the rounds and starts the loop over', () => {
    const t = loop({ state: 'failed', note: 'reviewer failed', rounds: [round(1, { review: 'done' }), round(2, { review: 'failed' })], reviewers: 2 })
    archiveAttempt(t)
    expect(t.history).toEqual([{ attempt: 2, note: 'reviewer failed', rounds: 2 }])
    expect(t).not.toHaveProperty('rounds')
    expect(t).not.toHaveProperty('reviewers')
    expect(parseAttemptHistory([{ attempt: 1, rounds: 3 }, { attempt: 2, rounds: 'x' }])).toEqual([{ attempt: 1, rounds: 3 }, { attempt: 2 }])
  })

  it('parseLoopRounds drops malformed rounds', () => {
    expect(parseLoopRounds(null)).toEqual({ reviewers: 0, rounds: [], dropped: 0 })
    expect(
      parseLoopRounds({
        reviewers: 2,
        rounds: [
          { round: 1, review: 'done', reviewer: 1, verdict: 'findings', findings: ['a'], work: { summary: 's', steered: false, at: 't', changedFiles: ['f'] } },
          { round: 2, review: 'nope' },
          { round: 0, review: 'pending' },
          { round: 2, review: 'pending', work: { summary: 1 } },
          { round: 3, review: 'failed', workerLost: true },
        ],
      }),
    ).toEqual({
      reviewers: 2,
      rounds: [
        { round: 1, review: 'done', reviewer: 1, verdict: 'findings', findings: ['a'], work: { summary: 's', steered: false, at: 't', changedFiles: ['f'] } },
        { round: 2, review: 'pending' },
        { round: 3, review: 'failed', workerLost: true },
      ],
      dropped: 2,
    })
  })
})

describe('derived views of loops and maps', () => {
  const child = (i: number, extra: Partial<WorkflowTask> = {}): WorkflowTask =>
    wfTask(`m.${i}`, [], { parent: 'm', index: i, item: `item ${i}`, ...extra })

  it('workflowProgress counts an expanded map as its live children', () => {
    expect(workflowProgress({ tasks: [wfTask('src', [], { state: 'done' }), wfTask('m', ['src'], { kind: 'map' })] })).toEqual({ done: 1, total: 2 })
    expect(
      workflowProgress({
        tasks: [
          wfTask('src', [], { state: 'done' }),
          wfTask('m', ['src'], { kind: 'map', state: 'running' }),
          child(1, { state: 'done' }),
          child(2, { state: 'cancelled' }),
          child(3, { state: 'running' }),
        ],
      }),
    ).toEqual({ done: 2, total: 3 })
  })

  it('childrenOf orders by index', () => {
    expect(childrenOf({ tasks: [child(2), wfTask('x', []), child(1)] }, 'm').map((t) => t.id)).toEqual(['m.1', 'm.2'])
  })

  it('describeWorkflow nests children under their map and describes loops', () => {
    const workflow: Workflow = {
      id: 'wf_abcdef123',
      project: '/p.git',
      leadKey: 'lead',
      leadLabel: 'Lead',
      title: 'T',
      goal: 'G',
      version: 2,
      status: 'running',
      tasks: [
        wfTask('src', [], { state: 'done', attempt: 1, result: { status: 'done', summary: 's', items: ['a', 'b'], steered: false, at: 't' } }),
        wfTask('impl', [], {
          kind: 'loop',
          state: 'running',
          attempt: 1,
          maxRounds: 3,
          reviewers: 1,
          rounds: [round(1, { review: 'done', reviewer: 1, verdict: 'findings', findings: ['f1', 'f2'] }), round(2, { review: 'running', reviewer: 2 })],
        }),
        wfTask('m', ['src'], { kind: 'map', state: 'running', over: 'src.result.items' }),
        wfTask('m2', ['src'], { kind: 'map', over: 'src.result.items' }),
        child(1, { state: 'done', attempt: 1, result: { status: 'done', summary: 'fixed\nmore', steered: true, at: 't' }, item: 'x'.repeat(130) }),
        child(2, { state: 'failed', attempt: 2, note: 'broke' }),
      ],
      patches: [],
      judgments: [],
      createdAt: 'then',
    }
    const body = describeWorkflow({ workflow, paused: null, workers: { impl: 'term-w', 'm.1': 'term-c' }, reviewers: { impl: 'term-r' } })
    expect(body.progress).toEqual({ done: 2, total: 5 })
    const tasks = body.tasks as Array<Record<string, unknown>>
    expect(tasks.map((t) => t.id)).toEqual(['src', 'impl', 'm', 'm2'])
    expect(tasks[1]).toEqual({
      id: 'impl',
      kind: 'loop',
      state: 'running',
      after: [],
      session_id: 'term-w',
      reviewer_session_id: 'term-r',
      loop: { round: 2, maxRounds: 3, phase: 'reviewing', lastVerdict: 'findings', openFindings: ['f1', 'f2'] },
    })
    expect(tasks[2].map).toEqual({
      over: 'src.result.items',
      items: 2,
      children: [
        { id: 'm.1', item: 'x'.repeat(120), state: 'done', session_id: 'term-c', summary: 'fixed', steered: true },
        { id: 'm.2', item: 'item 2', state: 'failed', attempt: 2, note: 'broke' },
      ],
    })
    expect(tasks[3].map).toEqual({ over: 'src.result.items', items: null })
  })
})

describe('review fixes', () => {
  it('refuses the nested worker and template specs, pointing at the flat form', () => {
    const problems = problemsOf(() =>
      parseNewWorkflow({
        title: 'T',
        goal: 'G',
        tasks: [task('src'), loopTask('l', { worker: { brief: 'B' } }), mapTask('m', { template: { brief: 'B' } })],
      }),
    )
    expect(problems).toEqual([
      "tasks[1].worker: a loop's own fields are its worker: put brief, provider, model, effort and worktree on the task itself",
      "tasks[2].template: a map's own fields are its template: put brief, acceptance, provider, model, effort and worktree on the task itself",
    ])
    expect(problemsOf(() => parseWorkflowOps([{ op: 'update', id: 'l', patch: { worker: { model: 'opus' } } }]))).toEqual([
      "ops[0].patch.worker: a loop's own fields are its worker: put brief, provider, model, effort and worktree on the task itself",
    ])
  })

  it('needs a worktree for a map, and reports a refused one once', () => {
    expect(problemsOf(() => parseNewWorkflow({ title: 'T', goal: 'G', tasks: [task('src'), mapTask('m', { worktree: undefined })] }))).toEqual([
      'tasks[1].worktree: a map needs a branch with {{index}} or {{item}}: its children write in parallel',
    ])
    const problems: string[] = []
    kindProblems({ kind: 'map', after: ['a'], over: 'a.result.items' }, 'ops[0]', problems)
    expect(problems).toEqual(['ops[0].worktree: a map needs a branch with {{index}} or {{item}}: its children write in parallel'])
  })

  const loop = (extra: Partial<WorkflowTask> = {}): WorkflowTask => wfTask('l', [], { kind: 'loop', attempt: 1, reviewers: 1, ...extra })

  it('a round whose worker was lost is no reviewer failure: no phase, and no kept worker slot', () => {
    const lost = loop({ state: 'failed', rounds: [{ round: 1, review: 'failed', reviewer: 1, workerLost: true }] })
    expect(loopPhase(lost)).toBeNull()
    expect(currentSlots(lost)).toEqual([])
    const reviewerFailed = loop({ state: 'failed', rounds: [{ round: 1, review: 'failed', reviewer: 1 }] })
    expect(loopPhase(reviewerFailed)).toBe('reviewer-failed')
    expect(currentSlots(reviewerFailed)).toEqual([{ taskId: 'l', attempt: 1 }])
  })

  it('detachedSlot keeps a cancelled loop\'s reviewer only while it was reviewing', () => {
    const worker = { taskId: 'l', attempt: 1 }
    const reviewer = { taskId: 'l', attempt: 1, review: 1 }
    const reviewing = loop({ state: 'cancelled', detached: true, rounds: [{ round: 1, review: 'running', reviewer: 1 }] })
    expect(detachedSlot(reviewing, worker)).toBe(true)
    expect(detachedSlot(reviewing, reviewer)).toBe(true)
    const between = loop({ state: 'cancelled', detached: true, rounds: [{ round: 1, review: 'done', reviewer: 1, verdict: 'findings' }, { round: 2, review: 'pending' }] })
    expect(detachedSlot(between, worker)).toBe(true)
    expect(detachedSlot(between, reviewer)).toBe(false)
    expect(detachedSlot({ ...between, detached: undefined }, worker)).toBe(false)
  })

  it('loopItems takes the latest round that reported items', () => {
    const work = (items?: string[]) => ({ summary: 's', steered: false, at: 't', ...(items ? { items } : {}) })
    expect(loopItems(loop({ rounds: [{ round: 1, review: 'done', work: work(['a', 'b']) }, { round: 2, review: 'done', work: work() }] }))).toEqual(['a', 'b'])
    expect(loopItems(loop({ rounds: [{ round: 1, review: 'done', work: work(['a']) }, { round: 2, review: 'done', work: work([]) }] }))).toEqual([])
    expect(loopItems(loop({ rounds: [{ round: 1, review: 'pending' }] }))).toBeUndefined()
  })
})
