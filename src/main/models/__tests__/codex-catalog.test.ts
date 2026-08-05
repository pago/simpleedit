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
})
