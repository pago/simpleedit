/**
 * The Codex exec contract.
 *
 * These deliberately assert PROPERTIES rather than the exact argv the builder
 * happens to produce. An `toEqual([...])` snapshot of the builder's own output
 * passes just as happily when every flag is wrong — it restates the
 * implementation instead of pinning what the run must guarantee. The flags
 * themselves were checked against `codex exec --help` (codex-cli 0.146.0).
 */
import { describe, expect, it } from 'vitest'
import { buildCodexExecArgs, codexAgentText, codexPrompt, codexTurnFailure } from '../runner'

/** Value passed to a flag, e.g. flagValue(args, '--sandbox') === 'read-only'. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

describe('buildCodexExecArgs', () => {
  it('runs the exec subcommand with machine-readable output', () => {
    const args = buildCodexExecArgs({ cwd: '/repo' })
    expect(args[0]).toBe('exec')
    expect(args).toContain('--json')
  })

  it('is read-only and leaves no session behind — these are analysis tasks', () => {
    const args = buildCodexExecArgs({ cwd: '/repo' })
    expect(flagValue(args, '--sandbox')).toBe('read-only')
    expect(args).toContain('--ephemeral')
  })

  /**
   * A bounded task runs with nobody watching, so it must never stop to ask for
   * approval — it would hang until the abort signal fires. Set through exec's
   * own `-c`, because `--ask-for-approval` is a root-command flag that `exec`
   * does not define.
   */
  it('disables approvals via a config override exec itself accepts', () => {
    const args = buildCodexExecArgs({ cwd: '/repo' })
    expect(args).toContain('approval_policy="never"')
    expect(args).not.toContain('--ask-for-approval')
    // Anything before the subcommand would depend on clap propagating inward.
    expect(args.indexOf('approval_policy="never"')).toBeGreaterThan(args.indexOf('exec'))
  })

  it('never bypasses the sandbox or hook trust', () => {
    const args = buildCodexExecArgs({ cwd: '/repo', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' }).join(' ')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args).not.toContain('--dangerously-bypass-hook-trust')
  })

  it('reads the prompt from stdin, and that argument stays last', () => {
    const args = buildCodexExecArgs({ cwd: '/repo', model: 'gpt-5.6-sol', reasoningEffort: 'max', skipGitRepoCheck: true })
    expect(args.at(-1)).toBe('-')
  })

  it('applies model and reasoning effort only when asked', () => {
    const bare = buildCodexExecArgs({ cwd: '/repo' })
    expect(bare).not.toContain('--model')
    expect(bare.join(' ')).not.toContain('model_reasoning_effort')

    const tuned = buildCodexExecArgs({ cwd: '/repo', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' })
    expect(flagValue(tuned, '--model')).toBe('gpt-5.6-sol')
    expect(tuned).toContain('model_reasoning_effort="xhigh"')
  })

  it('only skips the git-repo check when the caller opts in', () => {
    expect(buildCodexExecArgs({ cwd: '/repo' })).not.toContain('--skip-git-repo-check')
    expect(buildCodexExecArgs({ cwd: '/repo', skipGitRepoCheck: true })).toContain('--skip-git-repo-check')
  })
})

describe('codexAgentText', () => {
  it('takes the text of a completed agent message', () => {
    expect(codexAgentText({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }))
      .toBe('{"ok":true}')
  })

  /**
   * Codex emits item.started / item.updated for the same item before
   * item.completed. Those carry partial text, so accepting them would feed the
   * scanner prefixes of a message it is about to get in full.
   */
  it('ignores in-progress item events, keeping only the completed one', () => {
    expect(codexAgentText({ type: 'item.started', item: { type: 'agent_message', text: '{"par' } })).toBeNull()
    expect(codexAgentText({ type: 'item.updated', item: { type: 'agent_message', text: '{"partial' } })).toBeNull()
  })

  it('ignores non-message items and malformed events', () => {
    expect(codexAgentText({ type: 'item.completed', item: { type: 'reasoning', text: '{not a finding}' } })).toBeNull()
    expect(codexAgentText({ type: 'item.completed', item: { type: 'command_execution', text: 'ls' } })).toBeNull()
    expect(codexAgentText({ type: 'turn.completed' })).toBeNull()
    expect(codexAgentText({ type: 'item.completed', item: { type: 'agent_message', text: 42 } })).toBeNull()
    expect(codexAgentText(null)).toBeNull()
    expect(codexAgentText('nope')).toBeNull()
  })
})

describe('codexTurnFailure', () => {
  /**
   * A turn can fail while `codex exec` still exits 0 — without this the run
   * would read as a clean pass that merely found nothing.
   */
  it('surfaces a failed turn, with the reported message when there is one', () => {
    expect(codexTurnFailure({ type: 'turn.failed', error: { message: 'rate limit reached' } }))
      .toBe('rate limit reached')
    expect(codexTurnFailure({ type: 'turn.failed' })).toBe('codex reported a failed turn')
    expect(codexTurnFailure({ type: 'turn.failed', error: {} })).toBe('codex reported a failed turn')
  })

  it('is silent for every other event', () => {
    expect(codexTurnFailure({ type: 'turn.completed' })).toBeNull()
    expect(codexTurnFailure({ type: 'item.completed', item: { type: 'agent_message', text: 'x' } })).toBeNull()
    expect(codexTurnFailure(null)).toBeNull()
  })
})

describe('codexPrompt', () => {
  it('joins system and user text, and omits the gap when there is no system part', () => {
    expect(codexPrompt('system rules', 'review this')).toBe('system rules\n\nreview this')
    expect(codexPrompt('', 'review this')).toBe('review this')
  })
})
