import type { Workflow, WorkflowOp } from '../../shared/workflow'

export interface PatchOpRow {
  icon: '＋' | '✎' | '✕' | '↻' | '⇡' | '✓'
  text: string
  taskIds: string[]
}

export interface PatchRow {
  /** What the cards call it: "Added by patch n". */
  number: number
  version: number
  at: string
  ops: PatchOpRow[]
  taskIds: string[]
}

function opRow(op: WorkflowOp, titleOf: (id: string) => string | undefined): PatchOpRow {
  switch (op.op) {
    case 'add': {
      const { id, kind } = op.task
      return { icon: '＋', text: `added ${titleOf(id) ?? op.task.title} (${id}, ${kind})`, taskIds: [id] }
    }
    case 'update':
      return { icon: '✎', text: `${op.id}: ${Object.keys(op.patch).join(', ') || 'no changes'}`, taskIds: [op.id] }
    case 'cancel':
      return { icon: '✕', text: `cancelled ${op.id}`, taskIds: [op.id] }
    case 'retry':
      return { icon: '↻', text: `retried ${op.id}${op.brief !== undefined ? ' with a new brief' : ''}`, taskIds: [op.id] }
    case 'extend':
      return { icon: '⇡', text: `${op.id}: +${op.rounds} round${op.rounds === 1 ? '' : 's'}`, taskIds: [op.id] }
    case 'accept':
      return { icon: '✓', text: `accepted ${op.id} as is`, taskIds: [op.id] }
  }
}

/** The lead's patches, newest first. */
export function patchRows(workflow: Pick<Workflow, 'patches' | 'tasks'>): PatchRow[] {
  const titles = new Map(workflow.tasks.map((t) => [t.id, t.title]))
  const titleOf = (id: string): string | undefined => titles.get(id)
  return [...workflow.patches]
    .sort((a, b) => b.version - a.version)
    .map((patch) => {
      const ops = patch.ops.map((op) => opRow(op, titleOf))
      return { number: patch.version - 1, version: patch.version, at: patch.at, ops, taskIds: [...new Set(ops.flatMap((o) => o.taskIds))] }
    })
}

export function patchAge(at: string, now: number): string {
  const then = new Date(at).getTime()
  if (Number.isNaN(then)) return ''
  const minutes = Math.floor((now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
