/**
 * Unit tests for the inline worktree picker that surfaces from the Fork-into-
 * worktree menu item. The component is exercised in isolation here so we can
 * test the keyboard nav + filter + source-exclusion contract without standing
 * up the whole TerminalTabs tree.
 *
 * The component reads from two global stores:
 *   - worktreeList() in `worktrees.svelte.ts` — populated via refreshWorktrees
 *     during normal app boot, here driven directly by calling the store's
 *     internal _worktreeList update via refreshWorktrees mock.
 *   - getClaudeStatus(path) in `claude-status.svelte.ts` — defaults to 'idle'
 *     for any unknown path; we don't override unless a test cares.
 *
 * worktrees.svelte.ts exports refreshWorktrees() which invokes window.api;
 * we mock window.api here.
 */
import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tick } from 'svelte'
import ForkWorktreePicker from '../ForkWorktreePicker.svelte'
import { refreshWorktrees } from '../../../stores/worktrees.svelte'

const worktrees = [
  { path: '/repo/main', branch: 'main', isMain: true, isCurrent: false },
  { path: '/repo/feature-a', branch: 'feature-a', isMain: false, isCurrent: false },
  { path: '/repo/feature-b', branch: 'feature-b', isMain: false, isCurrent: false },
]

beforeEach(async () => {
  vi.stubGlobal('api', {
    invoke: vi.fn().mockImplementation((channel: string) => {
      if (channel === 'worktree:list') return Promise.resolve(worktrees)
      return Promise.resolve(undefined)
    }),
    on: vi.fn().mockReturnValue(() => {}),
    once: vi.fn(),
  })
  await refreshWorktrees()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ForkWorktreePicker', () => {
  it('renders every worktree except the source as a pickable row', async () => {
    render(ForkWorktreePicker, {
      x: 100, y: 100,
      sourceWorktreePath: '/repo/main',
      onpick: vi.fn(),
      onback: vi.fn(),
      onclose: vi.fn(),
    })
    await tick()

    expect(screen.getByRole('button', { name: /feature-a/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /feature-b/ })).not.toBeDisabled()
    // The source worktree row is rendered as disabled (so the user sees
    // "can't fork into the same worktree" rather than just missing).
    expect(screen.getByRole('button', { name: /main/ })).toBeDisabled()
  })

  it('filter input narrows the visible list', async () => {
    render(ForkWorktreePicker, {
      x: 0, y: 0,
      sourceWorktreePath: '/repo/main',
      onpick: vi.fn(),
      onback: vi.fn(),
      onclose: vi.fn(),
    })
    await tick()

    const filter = screen.getByPlaceholderText('filter worktrees…')
    await fireEvent.input(filter, { target: { value: 'feature-b' } })

    expect(screen.queryByRole('button', { name: /feature-a/ })).toBeNull()
    expect(screen.getByRole('button', { name: /feature-b/ })).toBeInTheDocument()
  })

  it('clicking a pickable row calls onpick with that worktree path', async () => {
    const onpick = vi.fn()
    render(ForkWorktreePicker, {
      x: 0, y: 0,
      sourceWorktreePath: '/repo/main',
      onpick,
      onback: vi.fn(),
      onclose: vi.fn(),
    })
    await tick()

    await fireEvent.click(screen.getByRole('button', { name: /feature-a/ }))
    expect(onpick).toHaveBeenCalledWith('/repo/feature-a')
  })

  it('clicking the disabled source row does not call onpick', async () => {
    const onpick = vi.fn()
    render(ForkWorktreePicker, {
      x: 0, y: 0,
      sourceWorktreePath: '/repo/main',
      onpick,
      onback: vi.fn(),
      onclose: vi.fn(),
    })
    await tick()

    const sourceRow = screen.getByRole('button', { name: /main/ })
    await fireEvent.click(sourceRow)
    expect(onpick).not.toHaveBeenCalled()
  })

  it('Esc calls onback (not onclose) — designer "Esc-once-pops" UX', async () => {
    const onback = vi.fn()
    const onclose = vi.fn()
    render(ForkWorktreePicker, {
      x: 0, y: 0,
      sourceWorktreePath: '/repo/main',
      onpick: vi.fn(),
      onback,
      onclose,
    })
    await tick()

    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onback).toHaveBeenCalledOnce()
    expect(onclose).not.toHaveBeenCalled()
  })

  it('clicking the ← back button calls onback', async () => {
    const onback = vi.fn()
    render(ForkWorktreePicker, {
      x: 0, y: 0,
      sourceWorktreePath: '/repo/main',
      onpick: vi.fn(),
      onback,
      onclose: vi.fn(),
    })
    await tick()

    await fireEvent.click(screen.getByRole('button', { name: 'Back to tab menu' }))
    expect(onback).toHaveBeenCalledOnce()
  })

  it('Arrow Down + Enter activates the focused row', async () => {
    const onpick = vi.fn()
    render(ForkWorktreePicker, {
      x: 0, y: 0,
      sourceWorktreePath: '/repo/main',
      onpick,
      onback: vi.fn(),
      onclose: vi.fn(),
    })
    await tick()

    const dialog = screen.getByRole('dialog')
    // Initial focus index lands on the first pickable row (feature-a is the
    // first non-source worktree). ArrowDown advances to feature-b. Enter picks.
    await fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    await fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(onpick).toHaveBeenCalledWith('/repo/feature-b')
  })

  it('the filter input is auto-focused on mount', async () => {
    render(ForkWorktreePicker, {
      x: 0, y: 0,
      sourceWorktreePath: '/repo/main',
      onpick: vi.fn(),
      onback: vi.fn(),
      onclose: vi.fn(),
    })
    await tick()
    expect(screen.getByPlaceholderText('filter worktrees…')).toHaveFocus()
  })
})
