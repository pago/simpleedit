import { render, screen } from '@testing-library/svelte'
import { describe, it, expect } from 'vitest'
import { tick } from 'svelte'
import { markdownViewStore } from '../markdownView.svelte'
import Consumer from './MarkdownViewConsumer.svelte'

describe('markdownViewStore reactivity', () => {
  // Regression: switching view mode worked once and then the UI locked, because
  // a derived over markdownViewStore.get(path) stopped updating after the path
  // had a stored entry (non-reactive Map + `?? _lastChosen` short-circuit).
  it('keeps a derived reader in sync across repeated switches', async () => {
    const path = '/repo/reactivity-' + Math.round(performance.now()) + '.md'
    render(Consumer, { path })

    const out = screen.getByTestId('mode')
    expect(out).toHaveTextContent('rendered') // default

    markdownViewStore.set(path, 'raw')
    await tick()
    expect(out).toHaveTextContent('raw')

    markdownViewStore.set(path, 'hybrid')
    await tick()
    expect(out).toHaveTextContent('hybrid')

    markdownViewStore.set(path, 'rendered')
    await tick()
    expect(out).toHaveTextContent('rendered')
  })
})
