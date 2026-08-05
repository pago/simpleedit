import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { validateSpec, validateSpecActions } from '../gen-ui-validate'
import type { Spec } from '../../shared/gen-ui-catalog'

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

  it('accepts a Diagram graph with referentially-valid edges', () => {
    const result = validateSpec({
      root: 'd',
      elements: {
        d: {
          type: 'Diagram',
          props: {
            kind: 'graph',
            nodes: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
            edges: [{ source: 'a', target: 'b' }],
          },
        },
      },
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a Diagram graph whose edge references an unknown node id', () => {
    const result = validateSpec({
      root: 'd',
      elements: {
        d: {
          type: 'Diagram',
          props: {
            kind: 'graph',
            nodes: [{ id: 'a', label: 'A' }],
            edges: [{ source: 'a', target: 'ghost' }],
          },
        },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('"ghost"'))).toBe(true)
    }
  })

  it('accepts a Diagram sequence and rejects messages referencing unknown actors', () => {
    expect(
      validateSpec({
        root: 'd',
        elements: {
          d: {
            type: 'Diagram',
            props: {
              kind: 'sequence',
              actors: [
                { id: 'u', label: 'User' },
                { id: 's', label: 'Server' },
              ],
              messages: [{ from: 'u', to: 's', label: 'GET /' }],
            },
          },
        },
      }).ok,
    ).toBe(true)

    const bad = validateSpec({
      root: 'd',
      elements: {
        d: {
          type: 'Diagram',
          props: {
            kind: 'sequence',
            actors: [{ id: 'u', label: 'User' }],
            messages: [{ from: 'u', to: 'mystery', label: 'x' }],
          },
        },
      },
    })
    expect(bad.ok).toBe(false)
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

const SAMPLE_DIFF = [
  'diff --git a/src/client.ts b/src/client.ts',
  'index 1111111..2222222 100644',
  '--- a/src/client.ts',
  '+++ b/src/client.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1',
  '+const b = 2',
].join('\n')

describe('validateSpec — DiffBlock', () => {
  it('accepts a DiffBlock carrying diff text', () => {
    const result = validateSpec({
      root: 'd',
      elements: { d: { type: 'DiffBlock', props: { diff: SAMPLE_DIFF } } },
    })
    expect(result.ok).toBe(true)
  })

  it('accepts title, language override and per-file actions', () => {
    const result = validateSpec({
      root: 'd',
      elements: {
        d: {
          type: 'DiffBlock',
          props: {
            diff: SAMPLE_DIFF,
            title: 'Step 1',
            language: 'shell',
            fileActions: [
              {
                path: 'src/client.ts',
                label: 'open',
                action: { type: 'open_file', path: 'src/client.ts', line: 2 },
              },
            ],
          },
        },
      },
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a DiffBlock with no diff content', () => {
    const result = validateSpec({
      root: 'd',
      elements: { d: { type: 'DiffBlock', props: { diff: '' } } },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === 'elements.d.props.diff')).toBe(true)
    }
  })

  it('rejects a fileActions entry whose action is not a known ActionRef', () => {
    const result = validateSpec({
      root: 'd',
      elements: {
        d: {
          type: 'DiffBlock',
          props: {
            diff: SAMPLE_DIFF,
            fileActions: [{ path: 'src/client.ts', action: { type: 'rm_rf', path: '/' } }],
          },
        },
      },
    })
    expect(result.ok).toBe(false)
  })
})

describe('validateSpecActions — per-action worktree', () => {
  // These paths only need to resolve, not exist — open_file gating is pure path math.
  const MAIN = '/repo/main'
  const OTHER = '/repo/feature'
  const UNION = [MAIN, OTHER]

  function specWithAction(action: Record<string, unknown>): Spec {
    return {
      root: 'b',
      elements: { b: { type: 'ActionButton', props: { label: 'go', action } } },
    }
  }

  it('validates open_file against the panel worktree when no action worktree is given', async () => {
    const inside = await validateSpecActions(
      specWithAction({ type: 'open_file', path: 'src/a.ts' }),
      MAIN,
      UNION,
    )
    expect(inside).toEqual([])

    const outside = await validateSpecActions(
      specWithAction({ type: 'open_file', path: '../../etc/passwd' }),
      MAIN,
      UNION,
    )
    expect(outside).toHaveLength(1)
    expect(outside[0].message).toContain('outside the active worktree')
  })

  it('accepts an action worktree that is a member of the window union', async () => {
    const issues = await validateSpecActions(
      specWithAction({ type: 'open_file', worktree: OTHER, path: 'src/b.ts' }),
      MAIN,
      UNION,
    )
    expect(issues).toEqual([])
  })

  it('rejects an action worktree outside the window union', async () => {
    const issues = await validateSpecActions(
      specWithAction({ type: 'open_file', worktree: '/somewhere/else', path: 'src/b.ts' }),
      MAIN,
      UNION,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('elements.b.props.action.worktree')
    expect(issues[0].message).toContain('not a worktree this window has registered')
  })

  it('rejects a path escaping the action worktree even when the worktree is allowed', async () => {
    const issues = await validateSpecActions(
      specWithAction({ type: 'open_file', worktree: OTHER, path: '../main/secret.ts' }),
      MAIN,
      UNION,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain(`outside worktree "${OTHER}"`)
  })

  it('does not enforce union membership when the caller supplies no union', async () => {
    const issues = await validateSpecActions(
      specWithAction({ type: 'open_file', worktree: OTHER, path: 'src/b.ts' }),
      MAIN,
    )
    expect(issues).toEqual([])
  })

  it('reports an unreachable show_diff commit against the worktree the action named', async () => {
    // Real directories that are not git repos: `cat-file` fails, so every hash
    // is unreachable — enough to prove the commit was checked in the action's
    // own worktree rather than the panel's.
    const root = mkdtempSync(join(tmpdir(), 'gen-ui-validate-'))
    const panel = join(root, 'panel')
    const named = join(root, 'named')
    mkdirSync(panel)
    mkdirSync(named)
    try {
      const issues = await validateSpecActions(
        specWithAction({ type: 'show_diff', worktree: named, commitHash: 'deadbeef' }),
        panel,
        [panel, named],
      )
      expect(issues).toHaveLength(1)
      expect(issues[0].message).toContain(named)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips the git check entirely when the named worktree is rejected', async () => {
    const issues = await validateSpecActions(
      specWithAction({ type: 'show_diff', worktree: '/not/a/worktree', commitHash: 'deadbeef' }),
      MAIN,
      UNION,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('not a worktree this window has registered')
  })

  it('leaves focus_block alone when it targets an element of the same spec', async () => {
    const spec: Spec = {
      root: 'sec',
      elements: {
        sec: { type: 'Section', props: { title: 'Step 1' }, children: ['jump', 'diff'] },
        jump: { type: 'ActionButton', props: { label: 'go', action: { type: 'focus_block', blockId: 'diff' } } },
        diff: { type: 'DiffBlock', props: { diff: SAMPLE_DIFF } },
      },
    }
    expect(await validateSpecActions(spec, MAIN, UNION)).toEqual([])
  })

  it('rejects a focus_block pointing at a block id the spec does not define', async () => {
    const issues = await validateSpecActions(
      specWithAction({ type: 'focus_block', blockId: 'ghost' }),
      MAIN,
      UNION,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('elements.b.props.action.blockId')
    expect(issues[0].message).toContain('"ghost"')
  })

  it('rejects a dead focus_block nested inside a FileList item action', async () => {
    const spec: Spec = {
      root: 'files',
      elements: {
        files: {
          type: 'FileList',
          props: {
            title: 'Read in this order',
            items: [
              { path: 'src/client.ts', action: { type: 'focus_block', blockId: 'diff' } },
              { path: 'src/server.ts', action: { type: 'focus_block', blockId: 'nowhere' } },
            ],
          },
        },
        diff: { type: 'DiffBlock', props: { diff: SAMPLE_DIFF } },
      },
    }
    const issues = await validateSpecActions(spec, MAIN, UNION)
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('elements.files.props.items.1.action.blockId')
    expect(issues[0].message).toContain('"nowhere"')
  })

  it('checks focus_block without touching the worktree or the file system', async () => {
    // No panel worktree, no union — a panel-local action must still validate.
    const issues = await validateSpecActions(
      specWithAction({ type: 'focus_block', blockId: 'ghost' }),
      '',
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('not an element of this spec')
  })

  it('finds actions nested inside DiffBlock fileActions', async () => {
    const spec: Spec = {
      root: 'd',
      elements: {
        d: {
          type: 'DiffBlock',
          props: {
            diff: SAMPLE_DIFF,
            fileActions: [
              { path: 'src/client.ts', action: { type: 'open_file', worktree: '/nope', path: 'src/client.ts' } },
            ],
          },
        },
      },
    }
    const issues = await validateSpecActions(spec, MAIN, UNION)
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toContain('fileActions')
  })
})
