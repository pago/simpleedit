import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
}))

import { codexProvider } from '../codex'

const base = { provider: 'codex' as const, terminalId: 'agent-codex-1', worktreePath: '/repo/topic' }

describe('codex provider', () => {
  it('launches the native TUI in the selected worktree with optional model and reasoning', () => {
    const plan = codexProvider.buildLaunch({
      ...base,
      target: { provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
    })
    expect(plan.executable).toBe('codex')
    expect(plan.args).toEqual(expect.arrayContaining([
      '-C', '/repo/topic', '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="xhigh"',
    ]))
    expect(plan.sessionId).toBeUndefined()
  })

  it('uses provider-native resume and fork commands', () => {
    expect(codexProvider.buildLaunch({ ...base, resumeSessionId: 'thr_123' }).args.slice(-2)).toEqual(['resume', 'thr_123'])
    expect(codexProvider.buildLaunch({ ...base, resumeSessionId: 'thr_123', forkSession: true }).args.slice(-2)).toEqual(['fork', 'thr_123'])
  })

  it('injects SimpleEdit MCP and all lifecycle reporters without bypassing hook trust', () => {
    const plan = codexProvider.buildLaunch({ ...base, bridgePort: 4123, bridgeToken: 'secret' })
    const joined = plan.args.join(' ')
    expect(joined).toContain('mcp_servers.simpleedit.command')
    expect(joined).toContain('mcp_servers.simpleedit.env={ SIMPLEEDIT_BRIDGE_PORT = "4123"')
    expect(joined).not.toContain('mcp_servers.simpleedit.env={"')
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd']) {
      expect(joined).toContain(`hooks.${event}`)
    }
    expect(joined).not.toContain('dangerously-bypass-hook-trust')
  })

  it('rejects model and thread ids with shell syntax', () => {
    expect(() => codexProvider.buildLaunch({ ...base, target: { provider: 'codex', model: 'x;rm' } })).toThrow(/Invalid model/)
    expect(() => codexProvider.buildLaunch({ ...base, resumeSessionId: 'x$(id)' })).toThrow(/Invalid session/)
  })
})
