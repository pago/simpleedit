import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
import UpdateBanner from '../UpdateBanner.svelte'

describe('UpdateBanner', () => {
  it('says the Mac was updated and reloads on request', async () => {
    const onreload = vi.fn()
    render(UpdateBanner, { onreload })
    expect(screen.getByTestId('update-banner')).toHaveTextContent('SimpleEdit was updated')
    await fireEvent.click(screen.getByTestId('update-reload'))
    expect(onreload).toHaveBeenCalledOnce()
  })
})
