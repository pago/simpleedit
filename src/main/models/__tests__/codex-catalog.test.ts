import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

import { parseCodexModelPage } from '../codex-catalog'

describe('Codex model catalog parsing', () => {
  it('filters hidden models and preserves reasoning/default metadata and pagination', () => {
    expect(parseCodexModelPage({
      data: [
        { id: 'hidden', displayName: 'Hidden', hidden: true },
        {
          id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', hidden: false,
          defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }], isDefault: true,
        },
      ],
      nextCursor: 'page-2',
    })).toEqual({
      models: [{ provider: 'openai', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'xhigh', 'ultra'], isDefault: true }],
      nextCursor: 'page-2',
    })
  })

  /**
   * Codex's app-server schema types `reasoningEffort` as any non-empty string,
   * so a value we don't model can show up whenever Codex ships one. Dropping it
   * beats casting it into our union, where it would reach the launch flags and
   * the settings pickers as something nothing can handle.
   */
  it('drops reasoning efforts outside the known set instead of trusting them', () => {
    const { models } = parseCodexModelPage({
      data: [{
        id: 'gpt-6', model: 'gpt-6', displayName: 'GPT-6', hidden: false,
        defaultReasoningEffort: 'transcendent',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'transcendent' },
          { reasoningEffort: 42 },
          {},
        ],
        isDefault: false,
      }],
    })
    expect(models[0].supportedReasoningEfforts).toEqual(['low'])
    expect(models[0].defaultReasoningEffort).toBeUndefined()
  })

  it('falls back to the id when no model field is present, and to the id for the name', () => {
    const { models, nextCursor } = parseCodexModelPage({
      data: [{ id: 'gpt-5.4', hidden: false, isDefault: false }],
    })
    expect(models).toEqual([{
      provider: 'openai', model: 'gpt-5.4', displayName: 'gpt-5.4',
      supportedReasoningEfforts: [], isDefault: false,
    }])
    expect(nextCursor).toBeNull()
  })

  it('tolerates a malformed page rather than throwing', () => {
    expect(parseCodexModelPage(undefined)).toEqual({ models: [], nextCursor: null })
    expect(parseCodexModelPage({ data: 'nope' })).toEqual({ models: [], nextCursor: null })
    expect(parseCodexModelPage({ data: [null, 7, 'x', { noId: true }] })).toEqual({ models: [], nextCursor: null })
  })
})
