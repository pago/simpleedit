import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
import ProjectSheet from '../ProjectSheet.svelte'
import type { RemoteProject } from '../../shared/ipc-types'

/**
 * Switching project empties the Sessions tab, so the sheet must ask before it
 * throws away a recording or a brief, and must refuse while something can be
 * neither dropped nor followed to the other window.
 */

const A: RemoteProject = { windowId: 1, repoPath: '/p/a.git', name: 'a', focused: false }
const B: RemoteProject = { windowId: 2, repoPath: '/p/b.git', name: 'b', focused: true }

function setup(overrides: Partial<{ blocked: string | null; discards: string[]; connected: boolean; projects: RemoteProject[] }> = {}) {
  const onpick = vi.fn()
  const onclose = vi.fn()
  render(ProjectSheet, {
    props: {
      projects: overrides.projects ?? [A, B],
      currentWindowId: 1,
      connected: overrides.connected ?? true,
      blocked: overrides.blocked ?? null,
      discards: overrides.discards ?? [],
      onpick,
      onclose,
    },
  })
  const option = (windowId: number) =>
    screen.getAllByTestId('project-option').find((el) => el.dataset.windowId === String(windowId))!
  return { onpick, onclose, option }
}

describe('ProjectSheet', () => {
  it('marks the connected project and switches to another on a tap', async () => {
    const { onpick, option } = setup()
    expect(option(1).getAttribute('aria-current')).toBe('true')
    expect(option(2).textContent).toContain('Focused on Mac')
    await fireEvent.click(option(2))
    expect(onpick).toHaveBeenCalledWith(B)
  })

  it('just closes when the current project is tapped', async () => {
    const { onpick, onclose, option } = setup()
    await fireEvent.click(option(1))
    expect(onpick).not.toHaveBeenCalled()
    expect(onclose).toHaveBeenCalled()
  })

  it('asks before discarding, and keeps everything on Keep', async () => {
    const { onpick, option } = setup({ discards: ['the recording for Fix login'] })
    await fireEvent.click(option(2))
    const confirm = screen.getByTestId('project-switch-confirm')
    expect(confirm.textContent).toContain('the recording for Fix login')
    expect(onpick).not.toHaveBeenCalled()

    await fireEvent.click(screen.getByText('Keep'))
    expect(screen.queryByTestId('project-switch-confirm')).toBeNull()
    expect(onpick).not.toHaveBeenCalled()

    await fireEvent.click(option(2))
    await fireEvent.click(screen.getByTestId('project-switch-confirmed'))
    expect(onpick).toHaveBeenCalledWith(B)
  })

  it('refuses while something cannot be dropped, and says why', async () => {
    const { onpick, option } = setup({ blocked: 'A new session is still starting. Switch once it has.' })
    expect(screen.getByTestId('project-blocked').textContent).toContain('still starting')
    expect((option(2) as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(option(2))
    expect(onpick).not.toHaveBeenCalled()
  })

  it('tells two windows on one repo apart', () => {
    const twin: RemoteProject = { ...A, windowId: 5, focused: false }
    setup({ projects: [A, twin] })
    expect(screen.getAllByTestId('project-option')[1].textContent).toContain('window 5')
  })

  it('says when no window has a project', () => {
    setup({ projects: [] })
    expect(screen.getByTestId('project-empty')).toBeTruthy()
  })
})
