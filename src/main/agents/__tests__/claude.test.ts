/**
 * Unit tests for the Claude provider's model application in `buildLaunch`
 * (local-model v0). SECURITY-SENSITIVE: the ollama env override must be
 * prefixed INLINE on the command string (a login shell would otherwise let the
 * user's profile clobber a pty `env` object), and both endpoint + model id are
 * validated before landing in the shell `-c` string.
 *
 * `buildLaunch` is exercised with no bridge (bridgePort/token omitted) so it
 * writes no temp files and touches no electron `app` paths — only `app` needs a
 * stub for the module to import.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
}))

import { claudeProvider } from '../claude'

function launch(model?: import('../../../shared/ipc-types').ModelRef) {
  return claudeProvider.buildLaunch({
    terminalId: 'term-1',
    worktreePath: '/repo',
    ...(model ? { model } : {}),
  })
}

describe('claude provider buildLaunch — model application', () => {
  it('ollama model prefixes the inline env override and appends --model', () => {
    const plan = launch({ provider: 'ollama', model: 'gpt-oss:20b' })
    expect(plan.executable).toBe('claude')
    expect(plan.env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    // The disable-nonessential-traffic flag is what suppresses Claude Code's
    // /v1/messages/count_tokens probe that otherwise hangs Ollama (#13949).
    expect(plan.args.slice(-2)).toEqual(['--model', 'gpt-oss:20b'])
  })

  it('ollama honours a custom endpoint', () => {
    const plan = launch({ provider: 'ollama', model: 'llama3.1', endpoint: 'http://192.168.1.5:11434' })
    expect(plan.env?.['ANTHROPIC_BASE_URL']).toBe('http://192.168.1.5:11434')
  })

  it('anthropic model adds --model with NO env override (normal cloud auth)', () => {
    const plan = launch({ provider: 'anthropic', model: 'claude-opus-4' })
    expect(plan.env).toBeUndefined()
    expect(plan.args.slice(-2)).toEqual(['--model', 'claude-opus-4'])
  })

  it('no model leaves the command unchanged from the cloud default', () => {
    const plan = launch()
    expect(plan.executable).toBe('claude')
    expect(plan.args).not.toContain('--model')
    expect(plan.env).toBeUndefined()
    // Fresh spawn (no resume): a pinned --session-id and nothing else.
    expect(plan.args).toEqual(['--session-id', expect.stringMatching(/^[0-9a-f-]+$/)])
  })

  it('rejects an ollama endpoint that is not an http(s) URL', () => {
    expect(() => launch({ provider: 'ollama', model: 'x', endpoint: 'file:///etc/passwd' })).toThrow(
      /Invalid Ollama endpoint/,
    )
    expect(() => launch({ provider: 'ollama', model: 'x', endpoint: 'http://a;rm -rf/' })).toThrow(
      /Invalid Ollama endpoint/,
    )
  })

  it('rejects a model id with shell-injection characters', () => {
    expect(() => launch({ provider: 'ollama', model: 'a; rm -rf /' })).toThrow(/Invalid model id/)
    expect(() => launch({ provider: 'anthropic', model: 'a$(whoami)' })).toThrow(/Invalid model id/)
  })
})
