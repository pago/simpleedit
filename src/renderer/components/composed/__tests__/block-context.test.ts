import { describe, it, expect } from 'vitest'
import { BLOCK_ID_PROP, stampBlockIds, describeBlock } from '../block-context'
import { buildAgentMessage } from '../../../lib/agent-message'
import type { Spec } from '../../../../shared/gen-ui-catalog'

const SPEC: Spec = {
  root: 'sec',
  elements: {
    sec: { type: 'Section', props: { title: 'Step 1' }, children: ['prose', 'diff'] },
    prose: { type: 'ProseBlock', props: { content: 'The retry loop moved into the client.' } },
    diff: { type: 'DiffBlock', props: { diff: 'diff --git a/a.ts b/a.ts\n+one\n' } },
  },
}

describe('stampBlockIds', () => {
  it('stamps every element key into its own props without touching the input', () => {
    const stamped = stampBlockIds(SPEC)
    expect(stamped.elements.prose.props[BLOCK_ID_PROP]).toBe('prose')
    expect(stamped.elements.sec.props[BLOCK_ID_PROP]).toBe('sec')
    expect(stamped.elements.sec.children).toEqual(['prose', 'diff'])
    expect(SPEC.elements.prose.props[BLOCK_ID_PROP]).toBeUndefined()
  })
})

describe('describeBlock', () => {
  it('returns prose content verbatim', () => {
    expect(describeBlock(SPEC.elements.prose)).toBe('The retry loop moved into the client.')
  })

  it('fences a diff so the receiving agent can read it as a diff', () => {
    const out = describeBlock(SPEC.elements.diff)
    expect(out.startsWith('```diff')).toBe(true)
    expect(out).toContain('+one')
  })

  it('fences a code snippet with its language', () => {
    const out = describeBlock({ type: 'CodeSnippet', props: { language: 'ts', code: 'const a = 1' } })
    expect(out).toBe('```ts\nconst a = 1\n```')
  })

  it('falls back to JSON for structural blocks, dropping the internal id prop', () => {
    const out = describeBlock({
      type: 'KeyValueSummary',
      props: { items: [{ label: 'Passed', value: '42' }], [BLOCK_ID_PROP]: 'kv' },
    })
    expect(out).toContain('"label": "Passed"')
    expect(out).not.toContain(BLOCK_ID_PROP)
  })

  it('truncates content that would flood a terminal', () => {
    const out = describeBlock({ type: 'ProseBlock', props: { content: 'x'.repeat(9000) } })
    expect(out.length).toBeLessThan(9000)
    expect(out).toContain('truncated')
  })

  it('returns an empty string for a missing element', () => {
    expect(describeBlock(undefined)).toBe('')
  })
})

describe('buildAgentMessage — block context', () => {
  it('is self-contained: names the block and carries both selection and content', () => {
    const message = buildAgentMessage(
      {
        kind: 'block',
        blockId: 'diff',
        blockType: 'DiffBlock',
        content: describeBlock(SPEC.elements.diff),
        selectedText: '+one',
      },
      'why this change?',
    )
    expect(message).toContain('[Panel block: DiffBlock "diff"]')
    expect(message).toContain('Selected:')
    expect(message).toContain('Block content:')
    expect(message).toContain('```diff')
    expect(message.endsWith('why this change?')).toBe(true)
  })

  it('does not repeat the content when the selection is the whole block', () => {
    const message = buildAgentMessage(
      {
        kind: 'block',
        blockId: 'prose',
        blockType: 'ProseBlock',
        content: 'same text',
        selectedText: 'same text',
      },
      '',
    )
    expect(message).toContain('Selected:')
    expect(message).not.toContain('Block content:')
  })
})
