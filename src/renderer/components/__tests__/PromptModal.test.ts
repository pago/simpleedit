import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
import { tick } from 'svelte'
import PromptModal from '../PromptModal.svelte'

describe('PromptModal', () => {
  it('renders with title, label, and default value', async () => {
    render(PromptModal, {
      title: 'Rename tab',
      label: 'New label',
      defaultValue: 'Claude',
      onsubmit: vi.fn(),
      oncancel: vi.fn(),
    })
    expect(screen.getByRole('dialog', { name: 'Rename tab' })).toBeInTheDocument()
    expect(screen.getByText('New label')).toBeInTheDocument()
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('Claude')
  })

  it('focuses and selects the default value on mount', async () => {
    render(PromptModal, {
      title: 'Rename tab',
      defaultValue: 'Claude',
      onsubmit: vi.fn(),
      oncancel: vi.fn(),
    })
    await tick()
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input).toHaveFocus()
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('Claude'.length)
  })

  it('Enter calls onsubmit with current value', async () => {
    const onsubmit = vi.fn()
    render(PromptModal, {
      title: 'Rename tab',
      defaultValue: 'old',
      onsubmit,
      oncancel: vi.fn(),
    })
    const input = screen.getByRole('textbox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'new' } })
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(onsubmit).toHaveBeenCalledWith('new')
  })

  it('Escape calls oncancel without submitting', async () => {
    const onsubmit = vi.fn()
    const oncancel = vi.fn()
    render(PromptModal, {
      title: 'Rename tab',
      defaultValue: 'old',
      onsubmit,
      oncancel,
    })
    const input = screen.getByRole('textbox')
    await fireEvent.keyDown(input, { key: 'Escape' })
    expect(oncancel).toHaveBeenCalledOnce()
    expect(onsubmit).not.toHaveBeenCalled()
  })

  it('confirm button is disabled when the value is empty', async () => {
    render(PromptModal, {
      title: 'Rename tab',
      defaultValue: '',
      confirmLabel: 'OK',
      onsubmit: vi.fn(),
      oncancel: vi.fn(),
    })
    const submit = screen.getByRole('button', { name: 'OK' })
    expect(submit).toBeDisabled()
  })

  it('shows validator error and disables submit when invalid', async () => {
    const validate = (v: string): string | null =>
      v.length > 5 ? 'too long' : null
    render(PromptModal, {
      title: 'Rename tab',
      defaultValue: 'short',
      confirmLabel: 'Rename',
      validate,
      onsubmit: vi.fn(),
      oncancel: vi.fn(),
    })
    const input = screen.getByRole('textbox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'definitely too long' } })
    expect(screen.getByText('too long')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
  })

  it('clicking the backdrop calls oncancel', async () => {
    const oncancel = vi.fn()
    const { container } = render(PromptModal, {
      title: 'Rename tab',
      defaultValue: 'x',
      onsubmit: vi.fn(),
      oncancel,
    })
    // The backdrop is the outermost fixed overlay.
    const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement
    expect(backdrop).not.toBeNull()
    await fireEvent.click(backdrop)
    expect(oncancel).toHaveBeenCalledOnce()
  })

  it('honors selectionRange for partial pre-selection', async () => {
    render(PromptModal, {
      title: 'Rename tab',
      defaultValue: 'name.ts',
      selectionRange: [0, 4],
      onsubmit: vi.fn(),
      oncancel: vi.fn(),
    })
    await tick()
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(4)
  })

  it('danger tone applies red styling to the confirm button', () => {
    render(PromptModal, {
      title: 'Delete',
      defaultValue: 'foo',
      confirmLabel: 'Delete',
      confirmTone: 'danger',
      onsubmit: vi.fn(),
      oncancel: vi.fn(),
    })
    const submit = screen.getByRole('button', { name: 'Delete' })
    expect(submit.className).toContain('bg-red-600')
  })
})
