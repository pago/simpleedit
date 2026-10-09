/**
 * The backlog as agents see it through `list_backlog` / `edit_backlog`.
 *
 * Agents speak a flatter shape than clients do: `provider` / `model`
 * instead of an `InteractiveTarget`, and no ids for what
 * they add (main mints them). This module translates in both directions; the
 * ops it produces still go through `parseBacklogOps`, so nothing an agent
 * sends reaches the store unchecked.
 */
import { BACKLOG_MAX_OPS, newBacklogItemId, type BacklogItem } from '../shared/backlog'
import type { InteractiveTarget, ModelRef } from '../shared/ipc-types'

/** A Claude model id from an agent: a cloud model or an installed local one. */
export type ClaudeModelResolver = (model: string) => Promise<ModelRef>

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const TARGET_KEYS = ['provider', 'model'] as const

/**
 * The target an agent's fields name: undefined when it named none, null for
 * `provider: "default"` (clear it). On an update, fields it left out keep the
 * item's current values — "use opus" must not reset the agent — unless
 * it switched provider, where the old model means nothing.
 */
async function targetOf(
  raw: Record<string, unknown>,
  current: InteractiveTarget | undefined,
  resolveClaudeModel: ClaudeModelResolver,
): Promise<unknown> {
  if (!TARGET_KEYS.some((k) => raw[k] !== undefined)) return undefined
  if (raw.provider === 'default') return null
  const base = raw.provider === undefined || raw.provider === current?.provider ? current : undefined
  const provider = raw.provider ?? base?.provider
  if (provider === undefined) throw new Error('Pass `provider` along with `model`.')
  const baseModel = base ? (base.provider === 'claude' ? base.model?.model : base.model) : undefined
  const model = raw.model !== undefined ? raw.model : baseModel
  if (provider === 'claude') {
    if (typeof model !== 'string' || !model) return { provider: 'claude' }
    if (base?.provider === 'claude' && raw.model === undefined && base.model) return { provider: 'claude', model: base.model }
    return { provider: 'claude', model: await resolveClaudeModel(model) }
  }
  return { provider, ...(model !== undefined && model !== '' ? { model } : {}) }
}

/**
 * Translate an agent's `edit_backlog` ops into `BacklogOp`-shaped input.
 * `added` lists the ids minted for its adds, in order, so the answer can name them.
 */
export async function fromAgentOps(
  raw: unknown,
  resolveClaudeModel: ClaudeModelResolver,
  current: readonly BacklogItem[] = [],
): Promise<{ ops: unknown[]; added: string[] }> {
  if (!Array.isArray(raw)) throw new Error('`ops` must be a list.')
  // Before any model is resolved: that can shell out per op.
  if (raw.length > BACKLOG_MAX_OPS) throw new Error(`A backlog edit takes at most ${BACKLOG_MAX_OPS} ops.`)
  const ops: unknown[] = []
  const added: string[] = []
  for (const op of raw) {
    if (!isObject(op)) throw new Error('Each op must be an object.')
    const existing = op.op === 'update' ? current.find((i) => i.id === op.id)?.target : undefined
    const target = await targetOf(op, existing, resolveClaudeModel)
    switch (op.op) {
      case 'add': {
        const id = newBacklogItemId()
        added.push(id)
        ops.push({
          kind: 'add',
          item: {
            id,
            prompt: op.prompt ?? '',
            ...(op.label !== undefined ? { label: op.label } : {}),
            ...(target ? { target } : {}),
          },
          ...(op.position !== undefined ? { index: op.position } : {}),
        })
        break
      }
      case 'update':
        ops.push({
          kind: 'update',
          id: op.id,
          ...(op.base_version !== undefined ? { baseVersion: op.base_version } : {}),
          patch: {
            ...(op.prompt !== undefined ? { prompt: op.prompt } : {}),
            ...(op.label !== undefined ? { label: op.label } : {}),
            ...(target !== undefined ? { target } : {}),
          },
        })
        break
      case 'remove':
        ops.push({ kind: 'remove', id: op.id })
        break
      case 'reorder':
        ops.push({ kind: 'reorder', ids: op.ids })
        break
      default:
        throw new Error(`Unknown backlog op ${JSON.stringify(op.op)}; use add, update, remove or reorder.`)
    }
  }
  return { ops, added }
}

/** An item as `list_backlog` shows it. */
export function toAgentItem(item: BacklogItem, position: number): Record<string, unknown> {
  const t = item.target
  return {
    id: item.id,
    position,
    ...(item.label ? { label: item.label } : {}),
    prompt: item.prompt,
    ...(t ? { provider: t.provider } : {}),
    ...(t?.model ? { model: typeof t.model === 'string' ? t.model : t.model.model } : {}),
    version: item.version,
    created_by: item.createdBySession ? `${item.createdBy} (${item.createdBySession})` : item.createdBy,
    ...(item.lastStart ? { last_start: `${item.lastStart.outcome}: ${item.lastStart.reason}` } : {}),
    ...(item.starting ? { starting: true } : {}),
  }
}
