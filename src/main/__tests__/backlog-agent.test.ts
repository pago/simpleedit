import { describe, it, expect, vi } from 'vitest'
import { fromAgentOps, toAgentItem } from '../backlog-agent'
import type { ModelRef } from '../../shared/ipc-types'

const resolveClaude = async (model: string): Promise<ModelRef> =>
  model.includes(':') ? { provider: 'ollama', model } : { provider: 'anthropic', model }

describe('fromAgentOps', () => {
  it('mints ids for adds and maps the agent fields onto a target', async () => {
    const { ops, added } = await fromAgentOps(
      [
        { op: 'add', prompt: 'p1', label: 'one', position: 0 },
        { op: 'add', prompt: 'p2', provider: 'codex', model: 'gpt-5.5' },
        { op: 'add', prompt: 'p3', provider: 'claude', model: 'qwen3:8b' },
      ],
      resolveClaude,
    )
    expect(added).toHaveLength(3)
    expect(added.every((id) => /^b_/.test(id))).toBe(true)
    expect(ops).toEqual([
      { kind: 'add', item: { id: added[0], prompt: 'p1', label: 'one' }, index: 0 },
      { kind: 'add', item: { id: added[1], prompt: 'p2', target: { provider: 'codex', model: 'gpt-5.5' } } },
      { kind: 'add', item: { id: added[2], prompt: 'p3', target: { provider: 'claude', model: { provider: 'ollama', model: 'qwen3:8b' } } } },
    ])
  })

  it('refuses an oversized batch before resolving any model', async () => {
    const resolve = vi.fn(resolveClaude)
    const ops = Array.from({ length: 51 }, () => ({ op: 'add', prompt: 'p', provider: 'claude', model: 'qwen3:8b' }))
    await expect(fromAgentOps(ops, resolve)).rejects.toThrow(/at most 50/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('adds a title-only item with an empty prompt', async () => {
    const { ops, added } = await fromAgentOps([{ op: 'add', label: 'later' }], resolveClaude)
    expect(ops).toEqual([{ kind: 'add', item: { id: added[0], prompt: '', label: 'later' } }])
  })

  it('maps update, remove and reorder, and refuses an unknown op', async () => {
    const { ops } = await fromAgentOps(
      [
        { op: 'update', id: 'b_aaaaaaaa', base_version: 3, prompt: 'new' },
        { op: 'remove', id: 'b_bbbbbbbb' },
        { op: 'reorder', ids: ['b_bbbbbbbb'] },
      ],
      resolveClaude,
    )
    expect(ops).toEqual([
      { kind: 'update', id: 'b_aaaaaaaa', baseVersion: 3, patch: { prompt: 'new' } },
      { kind: 'remove', id: 'b_bbbbbbbb' },
      { kind: 'reorder', ids: ['b_bbbbbbbb'] },
    ])
    await expect(fromAgentOps([{ op: 'start', id: 'b_aaaaaaaa' }], resolveClaude)).rejects.toThrow(/Unknown backlog op/)
  })
})

describe('agent targets on update', () => {
  const codexItem = {
    id: 'b_aaaaaaaa',
    prompt: 'p',
    target: { provider: 'codex' as const, model: 'gpt-5.5' },
    version: 1,
    createdAt: 'a',
    updatedAt: 'a',
    createdBy: 'desktop' as const,
  }

  it('keeps the model when the same provider is named again', async () => {
    const { ops } = await fromAgentOps([{ op: 'update', id: 'b_aaaaaaaa', provider: 'codex' }], resolveClaude, [codexItem])
    expect(ops).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', patch: { target: { provider: 'codex', model: 'gpt-5.5' } } }])
  })

  it('ignores a reasoning effort', async () => {
    const { ops } = await fromAgentOps([{ op: 'update', id: 'b_aaaaaaaa', model: 'gpt-5.4', reasoning_effort: 'high' }], resolveClaude, [codexItem])
    expect(ops).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', patch: { target: { provider: 'codex', model: 'gpt-5.4' } } }])
  })

  it('drops the old model when the provider changes', async () => {
    const { ops } = await fromAgentOps([{ op: 'update', id: 'b_aaaaaaaa', provider: 'claude' }], resolveClaude, [codexItem])
    expect(ops).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', patch: { target: { provider: 'claude' } } }])
  })

  it('clears the target with "default"', async () => {
    const { ops } = await fromAgentOps([{ op: 'update', id: 'b_aaaaaaaa', provider: 'default' }], resolveClaude, [codexItem])
    expect(ops).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', patch: { target: null } }])
  })

  it('refuses a model without a provider on add', async () => {
    await expect(fromAgentOps([{ op: 'add', prompt: 'p', model: 'gpt-5.5' }], resolveClaude)).rejects.toThrow(/Pass `provider`/)
  })
})

describe('toAgentItem', () => {
  it('shows an item flat, with who added it', () => {
    expect(
      toAgentItem(
        {
          id: 'b_aaaaaaaa',
          prompt: 'p',
          target: { provider: 'claude', model: { provider: 'anthropic', model: 'opus' } },
          version: 2,
          createdAt: 'a',
          updatedAt: 'b',
          createdBy: 'agent',
          createdBySession: 'parser',
        },
        0,
      ),
    ).toEqual({ id: 'b_aaaaaaaa', position: 0, prompt: 'p', provider: 'claude', model: 'opus', version: 2, created_by: 'agent (parser)' })
  })
})
