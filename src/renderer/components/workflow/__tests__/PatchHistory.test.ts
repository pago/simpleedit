import { render, screen } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
import '../../../app.css'
import PatchHistory from '../PatchHistory.svelte'
import type { Workflow } from '../../../../shared/workflow'

const workflow = {
  id: 'wf_abcdefgh',
  project: '/repo/p.git',
  leadKey: 'lead',
  leadLabel: 'Lead',
  title: 'Flow',
  goal: 'Goal',
  version: 3,
  status: 'running',
  tasks: [],
  patches: [{ version: 2, at: '2026-10-16T00:02:00.000Z', ops: [{ op: 'cancel', id: 'a' }] }],
  judgments: [],
  createdAt: '2026-10-16T00:00:00.000Z',
} satisfies Workflow

describe('PatchHistory', () => {
  it('keeps the op list out of the button, and a click anywhere on the row selects it', async () => {
    const onselect = vi.fn()
    render(PatchHistory, { props: { workflow, selected: 2, onselect } })
    const button = screen.getByTestId('workflow-patch')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.dataset.version).toBe('2')
    expect(button.querySelector('ul, li')).toBeNull()
    const row = screen.getByTestId('workflow-patch-row')
    const op = row.querySelector('ul li') as HTMLElement
    expect(op.textContent).toContain('a')
    const rect = op.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    expect(hit).toBe(button)
    button.click()
    expect(onselect).toHaveBeenCalledWith(null)
  })
})
