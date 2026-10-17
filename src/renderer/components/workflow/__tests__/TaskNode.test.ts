import { render, screen } from '@testing-library/svelte'
import { afterEach, describe, it, expect } from 'vitest'
import WorkflowGraph from '../WorkflowGraph.svelte'
import type { TaskCard } from '../../../lib/workflow-view'

const card = (over: Partial<TaskCard> = {}): TaskCard => ({
  id: 'fix',
  title: 'Fix each',
  kind: 'agent',
  tone: 'running',
  status: '▶ Running',
  agent: 'Claude',
  detail: '',
  depth: 0,
  added: false,
  hasWorker: true,
  highlight: null,
  ...over,
})

let host: HTMLDivElement | undefined
afterEach(() => host?.remove())

async function show(c: TaskCard): Promise<HTMLElement> {
  host = document.createElement('div')
  host.style.cssText = 'width: 800px; height: 400px'
  document.body.append(host)
  render(WorkflowGraph, { target: host, props: { cards: [c], after: {}, onselect: () => {} } })
  return screen.findByTestId('workflow-card')
}

describe('TaskNode', () => {
  it('says in words which patch changed a highlighted card', async () => {
    const node = await show(card({ highlight: 3 }))
    expect(node.textContent).toContain('Changed by patch 3.')
    expect(node.dataset.highlight).toBe('true')
  })

  it('says nothing of a patch when no card is highlighted', async () => {
    const node = await show(card())
    expect(node.textContent).not.toContain('patch')
  })

  it('gives the map progress bar a text equivalent', async () => {
    const node = await show(card({ kind: 'map', stack: { total: 4, done: 1, running: 1, waiting: 0, failed: 1, cancelled: 0 } }))
    expect(node.textContent).toContain('Progress: 1 of 4 done.')
    expect(screen.getByTestId('workflow-map-progress').getAttribute('aria-hidden')).toBe('true')
  })
})
