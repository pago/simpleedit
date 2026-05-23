import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
import { tick } from 'svelte'
import ContextMenu from '../ContextMenu.svelte'
import type { ContextMenuItem } from '../ContextMenu.svelte'

function items(): ContextMenuItem[] {
  return [
    { id: 'one', label: 'One' },
    { id: 'two', label: 'Two' },
    { id: 'three', label: 'Three', tone: 'danger', separatorBefore: true },
  ]
}

describe('ContextMenu', () => {
  it('renders all items and a separator before flagged entries', () => {
    render(ContextMenu, {
      x: 100, y: 100, items: items(),
      onpick: vi.fn(), onclose: vi.fn(),
    })
    expect(screen.getByRole('menuitem', { name: 'One' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Two' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Three' })).toBeInTheDocument()
    // separatorBefore renders an <hr>
    const menu = screen.getByRole('menu')
    expect(menu.querySelector('hr')).not.toBeNull()
  })

  it('focuses the first enabled item on mount', async () => {
    render(ContextMenu, {
      x: 0, y: 0, items: items(),
      onpick: vi.fn(), onclose: vi.fn(),
    })
    await tick()
    expect(screen.getByRole('menuitem', { name: 'One' })).toHaveFocus()
  })

  it('Arrow Down advances focus, wraps to top', async () => {
    render(ContextMenu, {
      x: 0, y: 0, items: items(),
      onpick: vi.fn(), onclose: vi.fn(),
    })
    await tick()
    const menu = screen.getByRole('menu')
    await fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Two' })).toHaveFocus()
    await fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Three' })).toHaveFocus()
    await fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'One' })).toHaveFocus()
  })

  it('Arrow Up wraps to the last enabled item', async () => {
    render(ContextMenu, {
      x: 0, y: 0, items: items(),
      onpick: vi.fn(), onclose: vi.fn(),
    })
    await tick()
    const menu = screen.getByRole('menu')
    await fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(screen.getByRole('menuitem', { name: 'Three' })).toHaveFocus()
  })

  it('Home focuses the first enabled item', async () => {
    const list: ContextMenuItem[] = [
      { id: 'a', label: 'A', disabled: true },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ]
    render(ContextMenu, {
      x: 0, y: 0, items: list,
      onpick: vi.fn(), onclose: vi.fn(),
    })
    await tick()
    const menu = screen.getByRole('menu')
    // Initial focus is on "B" (first enabled). Move to "C" then Home → "B" again.
    await fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'C' })).toHaveFocus()
    await fireEvent.keyDown(menu, { key: 'Home' })
    expect(screen.getByRole('menuitem', { name: 'B' })).toHaveFocus()
  })

  it('End focuses the last enabled item', async () => {
    const list: ContextMenuItem[] = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C', disabled: true },
    ]
    render(ContextMenu, {
      x: 0, y: 0, items: list,
      onpick: vi.fn(), onclose: vi.fn(),
    })
    await tick()
    const menu = screen.getByRole('menu')
    await fireEvent.keyDown(menu, { key: 'End' })
    // Last *enabled* item is "B", not the disabled "C".
    expect(screen.getByRole('menuitem', { name: 'B' })).toHaveFocus()
  })

  it('Arrow nav skips disabled items', async () => {
    const list: ContextMenuItem[] = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', disabled: true, disabledTooltip: 'No' },
      { id: 'c', label: 'C' },
    ]
    render(ContextMenu, {
      x: 0, y: 0, items: list,
      onpick: vi.fn(), onclose: vi.fn(),
    })
    await tick()
    const menu = screen.getByRole('menu')
    await fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'C' })).toHaveFocus()
    // ArrowDown again wraps past disabled "B" straight to "A".
    await fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'A' })).toHaveFocus()
  })

  it('disabled items have aria-disabled and a tooltip', () => {
    const list: ContextMenuItem[] = [
      { id: 'x', label: 'Blocked', disabled: true, disabledTooltip: 'Why blocked' },
    ]
    render(ContextMenu, {
      x: 0, y: 0, items: list,
      onpick: vi.fn(), onclose: vi.fn(),
    })
    const item = screen.getByRole('menuitem', { name: 'Blocked' })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveAttribute('title', 'Why blocked')
  })

  it('Enter on a focused item triggers onpick and onclose', async () => {
    const onpick = vi.fn()
    const onclose = vi.fn()
    render(ContextMenu, {
      x: 0, y: 0, items: items(),
      onpick, onclose,
    })
    await tick()
    const menu = screen.getByRole('menu')
    await fireEvent.keyDown(menu, { key: 'ArrowDown' })
    await fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onpick).toHaveBeenCalledWith('two')
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('Space activates the focused item', async () => {
    const onpick = vi.fn()
    render(ContextMenu, {
      x: 0, y: 0, items: items(),
      onpick, onclose: vi.fn(),
    })
    await tick()
    const menu = screen.getByRole('menu')
    await fireEvent.keyDown(menu, { key: ' ' })
    expect(onpick).toHaveBeenCalledWith('one')
  })

  it('Escape closes without picking', async () => {
    const onpick = vi.fn()
    const onclose = vi.fn()
    render(ContextMenu, {
      x: 0, y: 0, items: items(),
      onpick, onclose,
    })
    await tick()
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(onpick).not.toHaveBeenCalled()
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('clicking a disabled item does not pick', async () => {
    const onpick = vi.fn()
    const onclose = vi.fn()
    const list: ContextMenuItem[] = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', disabled: true },
    ]
    render(ContextMenu, {
      x: 0, y: 0, items: list,
      onpick, onclose,
    })
    await fireEvent.click(screen.getByRole('menuitem', { name: 'B' }))
    expect(onpick).not.toHaveBeenCalled()
    expect(onclose).not.toHaveBeenCalled()
  })

  it('clicking an enabled item picks and closes', async () => {
    const onpick = vi.fn()
    const onclose = vi.fn()
    render(ContextMenu, {
      x: 0, y: 0, items: items(),
      onpick, onclose,
    })
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Three' }))
    expect(onpick).toHaveBeenCalledWith('three')
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('pointerdown outside the menu closes it', async () => {
    const onclose = vi.fn()
    render(ContextMenu, {
      x: 0, y: 0, items: items(),
      onpick: vi.fn(), onclose,
    })
    // Synthesise a pointerdown on document.body — outside the menu element.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('danger tone applies red text class', () => {
    render(ContextMenu, {
      x: 0, y: 0, items: items(),
      onpick: vi.fn(), onclose: vi.fn(),
    })
    const danger = screen.getByRole('menuitem', { name: 'Three' })
    expect(danger.className).toContain('text-red-400')
  })
})
