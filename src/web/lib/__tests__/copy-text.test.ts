import { describe, it, expect, vi, afterEach } from 'vitest'
import { copyText } from '../copy-text'

describe('copyText', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses the async clipboard where the page has one', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await copyText('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  // A phone on plain LAN http is not a secure context, so it has no navigator.clipboard.
  it('falls back to a selected field and execCommand, and leaves nothing behind', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    let selected = ''
    const exec = vi.spyOn(document, 'execCommand').mockImplementation(() => {
      const field = document.activeElement as HTMLTextAreaElement | null
      selected = field?.value ?? document.querySelector('textarea')?.value ?? ''
      return true
    })
    await copyText('hello')
    expect(exec).toHaveBeenCalledWith('copy')
    expect(selected).toBe('hello')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('reports a refused copy', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    vi.spyOn(document, 'execCommand').mockReturnValue(false)
    await expect(copyText('hello')).rejects.toThrow('Copying is not allowed here')
  })
})
