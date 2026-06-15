import { render, screen, waitFor } from '@testing-library/svelte'
import { describe, it, expect } from 'vitest'
import MarkdownPreview from '../MarkdownPreview.svelte'

describe('MarkdownPreview', () => {
  it('renders sanitized markdown with prose styling', async () => {
    render(MarkdownPreview, {
      source: '# Hello\n\nworld',
      filePath: '/repo/docs/readme.md',
      worktreeRoot: '/repo',
    })
    const preview = screen.getByTestId('markdown-preview')
    await waitFor(() => expect(preview.querySelector('h1')).not.toBeNull())
    expect(preview.querySelector('h1')!.textContent).toContain('Hello')
  })

  it('rewrites a relative image to the wt-asset protocol', async () => {
    render(MarkdownPreview, {
      source: '![alt](./pic.png)',
      filePath: '/repo/docs/readme.md',
      worktreeRoot: '/repo',
    })
    const preview = screen.getByTestId('markdown-preview')
    await waitFor(() => {
      const img = preview.querySelector('img')
      expect(img?.getAttribute('src')?.startsWith('wt-asset://local')).toBe(true)
    })
    expect(preview.querySelector('img')!.getAttribute('src')).toContain('/repo/docs/pic.png')
  })

  it('syntax-highlights fenced code via Monaco', async () => {
    render(MarkdownPreview, {
      source: '```ts\nconst answer = 42\n```',
      filePath: '/repo/docs/readme.md',
      worktreeRoot: '/repo',
    })
    const preview = screen.getByTestId('markdown-preview')
    await waitFor(
      () => expect(preview.querySelector('code .mtk1, code [class^="mtk"]')).not.toBeNull(),
      { timeout: 4000 },
    )
  })
})
