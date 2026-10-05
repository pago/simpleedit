import { describe, it, expect, afterEach } from 'vitest'
import '../app.css'

// iOS zooms into a focused field under 16px; the utilities on the phone's
// fields ask for less, and the base rule has to win over them.
describe('phone form fields', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it.each(['input', 'textarea', 'select'])('renders a %s at 16px despite a smaller text utility', (tag) => {
    const el = document.createElement(tag)
    el.className = 'text-sm text-xs text-[12px]'
    document.body.append(el)
    expect(getComputedStyle(el).fontSize).toBe('16px')
  })
})
