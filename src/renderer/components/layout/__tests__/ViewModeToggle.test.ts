import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
import ViewModeToggle from '../ViewModeToggle.svelte'

describe('ViewModeToggle', () => {
  it('marks the current mode as pressed', () => {
    render(ViewModeToggle, { current: 'hybrid', onsetmode: vi.fn() })
    const hybrid = screen.getByTestId('md-view-toggle').querySelector('[data-mode="hybrid"]')!
    expect(hybrid).toHaveAttribute('aria-pressed', 'true')
    const raw = screen.getByTestId('md-view-toggle').querySelector('[data-mode="raw"]')!
    expect(raw).toHaveAttribute('aria-pressed', 'false')
  })

  it('calls onsetmode with the clicked mode', async () => {
    const onsetmode = vi.fn()
    render(ViewModeToggle, { current: 'rendered', onsetmode })
    const raw = screen.getByTestId('md-view-toggle').querySelector('[data-mode="raw"]') as HTMLElement
    await fireEvent.click(raw)
    expect(onsetmode).toHaveBeenCalledWith('raw')
  })
})
