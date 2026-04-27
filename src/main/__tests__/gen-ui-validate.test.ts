import { describe, it, expect } from 'vitest'
import { validateSpec } from '../gen-ui-validate'

describe('validateSpec — schema layer', () => {
  it('accepts a minimal valid spec rooted at a known primitive', () => {
    const result = validateSpec({
      root: 'r',
      elements: {
        r: { type: 'ProseBlock', props: { content: 'hello' } },
      },
    })
    expect(result.ok).toBe(true)
  })

  it('accepts a Section with children referencing other elements', () => {
    const result = validateSpec({
      root: 'sec',
      elements: {
        sec: { type: 'Section', props: { title: 'Details' }, children: ['a', 'b'] },
        a: { type: 'ProseBlock', props: { content: 'one' } },
        b: { type: 'StatusIndicator', props: { kind: 'ok', label: 'fine' } },
      },
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a spec whose root is missing from elements', () => {
    const result = validateSpec({ root: 'ghost', elements: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues[0].path).toBe('root')
    }
  })

  it('rejects an unknown component type with a clear message', () => {
    const result = validateSpec({
      root: 'r',
      elements: { r: { type: 'NotAPrimitive', props: {} } },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('unknown component type'))).toBe(true)
    }
  })

  it('rejects the Diagram primitive — reserved for a future release', () => {
    const result = validateSpec({
      root: 'd',
      elements: { d: { type: 'Diagram', props: { kind: 'graph', nodes: [], edges: [] } } },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues[0].message).toContain('Diagram')
    }
  })

  it('rejects when a primitive prop fails its catalog schema', () => {
    const result = validateSpec({
      root: 'r',
      elements: {
        r: { type: 'DecisionCard', props: { question: 'Q', options: [] } },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.startsWith('elements.r.props.options'))).toBe(true)
    }
  })

  it('rejects a child reference that does not exist in elements', () => {
    const result = validateSpec({
      root: 'sec',
      elements: {
        sec: { type: 'Section', props: { title: 'x' }, children: ['ghost'] },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues[0].message).toContain('ghost')
    }
  })

  it('rejects a missing top-level shape (not an object, missing root, etc.)', () => {
    expect(validateSpec(null).ok).toBe(false)
    expect(validateSpec({ root: 'r' }).ok).toBe(false)
    expect(validateSpec({ elements: {} }).ok).toBe(false)
  })
})
