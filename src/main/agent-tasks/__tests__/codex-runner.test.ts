import { describe, expect, it } from 'vitest'
import { buildCodexExecArgs, codexAgentText, codexPrompt } from '../runner'

describe('CodexRunner command contract', () => {
  it('always uses ephemeral, JSON, read-only execution with approvals disabled', () => {
    expect(buildCodexExecArgs({ cwd: '/tmp', skipGitRepoCheck: true })).toEqual([
      '--ask-for-approval', 'never', 'exec', '--json', '--ephemeral', '--sandbox', 'read-only',
      '--skip-git-repo-check', '-',
    ])
  })

  it('accepts only agent-message JSONL payload text', () => {
    expect(codexAgentText({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } })).toBe('{"ok":true}')
    expect(codexAgentText({ type: 'item.completed', item: { type: 'reasoning', text: '{not a finding}' } })).toBeNull()
    expect(codexAgentText(null)).toBeNull()
  })

  it('applies model and reasoning overrides and combines system/user input on stdin', () => {
    expect(buildCodexExecArgs({ cwd: '/repo', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' })).toEqual(expect.arrayContaining([
      '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="xhigh"',
    ]))
    expect(codexPrompt('system rules', 'review this')).toBe('system rules\n\nreview this')
  })
})
