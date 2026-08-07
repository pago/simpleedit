import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
}))

import { codexProvider, hookCommand, HOOK_EVENTS } from '../codex'

const base = { provider: 'codex' as const, terminalId: 'agent-codex-1', worktreePath: '/repo/topic' }

/** The `-c hooks.<Event>=…` value for one event, as Codex will receive it. */
function hookArgFor(args: string[], event: string): string | undefined {
  const i = args.findIndex((a) => a.startsWith(`hooks.${event}=`))
  return i === -1 ? undefined : args[i]
}

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
    for (const event of HOOK_EVENTS) {
      expect(hookArgFor(plan.args, event)).toBeDefined()
    }
    expect(joined).not.toContain('dangerously-bypass-hook-trust')
  })

  /**
   * Codex hashes the hook COMMAND STRING to decide whether a hook is trusted,
   * and refuses to run untrusted hooks silently. Per-session data in the command
   * therefore re-rolls the hash every launch and permanently invalidates the
   * user's grant — the defect that made Codex status, session identity, cwd
   * tracking, Fork and resume all dead on arrival.
   */
  it('keeps per-session data OUT of the hook command so its trust hash is stable', () => {
    const a = codexProvider.buildLaunch({ ...base, bridgePort: 4123, bridgeToken: 'secretA' })
    const b = codexProvider.buildLaunch({
      ...base, terminalId: 'agent-codex-2', bridgePort: 5999, bridgeToken: 'secretB',
    })

    for (const event of HOOK_EVENTS) {
      const argA = hookArgFor(a.args, event)!
      expect(argA).toBe(hookArgFor(b.args, event))
      // Nothing session-scoped may appear in the hashed command.
      expect(argA).not.toContain('4123')
      expect(argA).not.toContain('secretA')
      expect(argA).not.toContain('agent-codex-1')
      expect(argA).toContain('--codex-hook-reporter')
    }
  })

  it('passes the bridge coordinates through the environment instead', () => {
    const plan = codexProvider.buildLaunch({ ...base, bridgePort: 4123, bridgeToken: 'secret' })
    expect(plan.env).toEqual({
      SIMPLEEDIT_BRIDGE_PORT: '4123',
      SIMPLEEDIT_BRIDGE_TOKEN: 'secret',
      SIMPLEEDIT_TERMINAL_ID: 'agent-codex-1',
    })
    // The server path is quoted — a packaged install lives under a path with
    // spaces ("Application Support"), and Codex runs the command through a shell.
    expect(hookCommand('/Some App/out/mcp-server/index.mjs')).toBe(
      "node '/Some App/out/mcp-server/index.mjs' --codex-hook-reporter",
    )
  })

  it('wires no bridge env when the window has no bridge', () => {
    expect(codexProvider.buildLaunch({ ...base }).env).toBeUndefined()
  })

  it('rejects model and thread ids with shell syntax', () => {
    expect(() => codexProvider.buildLaunch({ ...base, target: { provider: 'codex', model: 'x;rm' } })).toThrow(/Invalid model/)
    expect(() => codexProvider.buildLaunch({ ...base, resumeSessionId: 'x$(id)' })).toThrow(/Invalid session/)
  })
})
