/**
 * `focus_block` navigation. The DOM half runs against a hand-built panel rather
 * than a rendered `ComposedPanel`, which vitest cannot mount (json-render is
 * prebundled with a second Svelte runtime) — so the fixture reproduces the two
 * structural facts the real renderer provides: a `display: contents` boundary
 * per block, and a Section whose children are absent while it is collapsed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ancestorSectionIds, focusBlock, FLASH_CLASS } from '../focus-block'
import type { Spec } from '../../../../shared/gen-ui-catalog'

const SPEC: Spec = {
  root: 'outer',
  elements: {
    outer: { type: 'Section', props: { title: 'Tour' }, children: ['index', 'inner'] },
    index: { type: 'FileList', props: { items: [{ path: 'a.ts' }] } },
    inner: { type: 'Section', props: { title: 'Step 1' }, children: ['row'] },
    row: { type: 'Row', props: {}, children: ['diff'] },
    diff: { type: 'DiffBlock', props: { diff: 'diff --git a/a.ts b/a.ts\n+one\n' } },
  },
}

describe('ancestorSectionIds', () => {
  it('lists only the enclosing Sections, outermost first', () => {
    expect(ancestorSectionIds(SPEC, 'diff')).toEqual(['outer', 'inner'])
  })

  it('ignores non-Section containers on the way up', () => {
    expect(ancestorSectionIds(SPEC, 'diff')).not.toContain('row')
  })

  it('returns nothing for a top-level block or an unknown id', () => {
    expect(ancestorSectionIds(SPEC, 'outer')).toEqual([])
    expect(ancestorSectionIds(SPEC, 'ghost')).toEqual([])
  })

  it('terminates on a spec whose children form a cycle', () => {
    const cyclic: Spec = {
      root: 'a',
      elements: {
        a: { type: 'Section', props: {}, children: ['b'] },
        b: { type: 'Section', props: {}, children: ['a'] },
      },
    }
    expect(ancestorSectionIds(cyclic, 'b')).toEqual(['a'])
  })
})

/**
 * A block wrapper shaped like `BlockBoundary`: `display: contents`, so the
 * boundary itself has no box and only its child can be scrolled or outlined.
 */
function block(id: string, type: string, bodyId: string): HTMLElement {
  const boundary = document.createElement('div')
  boundary.dataset.blockId = id
  boundary.dataset.blockType = type
  boundary.style.display = 'contents'
  const body = document.createElement('div')
  body.id = bodyId
  body.textContent = id
  boundary.append(body)
  return boundary
}

/**
 * A Section that adds and removes its children as it opens and closes, the way
 * Svelte's `{#if open}` does — so a collapsed one really has no target inside.
 */
function section(id: string, open: boolean, body: HTMLElement): HTMLElement {
  const boundary = document.createElement('div')
  boundary.dataset.blockId = id
  boundary.dataset.blockType = 'Section'
  boundary.style.display = 'contents'

  const host = document.createElement('section')
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.setAttribute('data-section-toggle', '')
  toggle.setAttribute('aria-expanded', String(open))
  const slot = document.createElement('div')
  host.append(toggle, slot)
  boundary.append(host)
  if (open) slot.append(body)

  toggle.addEventListener('click', () => {
    const nowOpen = toggle.getAttribute('aria-expanded') !== 'true'
    toggle.setAttribute('aria-expanded', String(nowOpen))
    if (nowOpen) slot.append(body)
    else body.remove()
  })
  return boundary
}

describe('focusBlock', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    root.style.height = '200px'
    root.style.overflowY = 'auto'
    document.body.appendChild(root)
  })

  afterEach(() => {
    root.remove()
  })

  const expandedFlags = (): string[] =>
    [...root.querySelectorAll('[data-section-toggle]')].map((t) => t.getAttribute('aria-expanded') ?? '')

  const flashed = (id: string): boolean =>
    root.querySelector(`#${id}`)?.classList.contains(FLASH_CLASS) ?? false

  it('flashes the target block and not its display:contents boundary', async () => {
    root.append(block('diff', 'DiffBlock', 'diff-body'))

    expect(await focusBlock(root, SPEC, 'diff')).toBe(true)

    expect(flashed('diff-body')).toBe(true)
    expect(root.querySelector('[data-block-id="diff"]')!.classList.contains(FLASH_CLASS)).toBe(false)
  })

  it('expands every collapsed ancestor Section before landing', async () => {
    root.append(section('outer', false, section('inner', false, block('diff', 'DiffBlock', 'diff-body'))))

    // The target does not exist yet: a collapsed Section renders no children.
    expect(root.querySelector('[data-block-id="diff"]')).toBeNull()

    expect(await focusBlock(root, SPEC, 'diff')).toBe(true)

    expect(expandedFlags()).toEqual(['true', 'true'])
    expect(flashed('diff-body')).toBe(true)
  })

  it('leaves an already-open Section open', async () => {
    root.append(section('outer', true, block('index', 'FileList', 'index-body')))

    expect(await focusBlock(root, SPEC, 'index')).toBe(true)
    expect(expandedFlags()).toEqual(['true'])
    expect(flashed('index-body')).toBe(true)
  })

  it('reports a miss instead of throwing when the block is not rendered', async () => {
    root.append(block('index', 'FileList', 'index-body'))
    expect(await focusBlock(root, SPEC, 'diff')).toBe(false)
  })

  it('tolerates a block id that needs CSS escaping', async () => {
    const spec: Spec = { root: 'a.b:c', elements: { 'a.b:c': { type: 'ProseBlock', props: {} } } }
    root.append(block('a.b:c', 'ProseBlock', 'odd'))

    expect(await focusBlock(root, spec, 'a.b:c')).toBe(true)
    expect(flashed('odd')).toBe(true)
  })
})
