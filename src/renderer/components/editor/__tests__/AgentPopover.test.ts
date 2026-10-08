import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
import AgentPopover from '../AgentPopover.svelte'
import type { AgentContext } from '../../../lib/agent-message'

const context: AgentContext = {
  kind: 'editor',
  filePath: '/wt/src/a.ts',
  selectedText: 'const a = 1',
  lineRange: [4, 4],
  lines: { startLine: 4, endLine: 4, snippet: 'const a = 1', before: '', after: '' },
}

function renderPopover(onsend: (t: string, message: string, comment: string) => void | Promise<void>) {
  // `props:` explicitly: `context` is also a mount option.
  return render(AgentPopover, { props: { x: 0, y: 0, context, terminals: [{ id: 's1', label: 'agent' }], onclose: vi.fn(), onsend } })
}

describe('AgentPopover', () => {
  it('hands over the comment alone beside the prompt built around it', async () => {
    const onsend = vi.fn()
    renderPopover(onsend)
    await fireEvent.input(screen.getByPlaceholderText('Discuss this with agent...'), { target: { value: '  rename this  ' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onsend).toHaveBeenCalledWith('s1', expect.stringContaining('[File: /wt/src/a.ts, lines 4-4]'), 'rename this')
  })

  it('stays open with the text when sending fails', async () => {
    renderPopover(() => Promise.reject(new Error('Malformed thread op')))
    const box = screen.getByPlaceholderText('Discuss this with agent...')
    await fireEvent.input(box, { target: { value: 'rename this' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Not sent: Malformed thread op'))
    expect(box).toHaveValue('rename this')
  })
})
