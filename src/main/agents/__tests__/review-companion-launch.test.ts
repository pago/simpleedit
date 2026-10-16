/**
 * A review companion's launch is read-only per provider, and a normal launch
 * is untouched. Assertions are on what each flag must guarantee: Claude's
 * settings file denies the writing tools (and Bash) without hiding MCP, the
 * checkout dir is readable without swallowing the prompt, Codex runs in the
 * read-only sandbox, OpenCode denies edits and shell yet keeps its MCP config.
 */
import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app' } }))

import { claudeProvider, REVIEW_COMPANION_DENY } from '../claude'
import { codexProvider } from '../codex'
import { opencodeProvider } from '../opencode'
import type { LaunchContext, LaunchPlan } from '../provider'

const companion = { reviewId: 'r_review01', extraReadDir: '/data/review-checkouts/r_review01' }
const bridge = { bridgePort: 4321, bridgeToken: 'tok' }

function settingsOf(plan: LaunchPlan): Record<string, unknown> {
  const at = plan.args.indexOf('--settings')
  expect(at).toBeGreaterThan(-1)
  return JSON.parse(readFileSync(plan.args[at + 1]!, 'utf8')) as Record<string, unknown>
}

describe('Claude companion launch', () => {
  it('denies the writing tools and Bash in its settings, keeps the hooks and MCP', () => {
    const plan = claudeProvider.buildLaunch({ terminalId: 'c1', worktreePath: '/repo', ...bridge, reviewCompanion: companion, initialPrompt: 'brief' })
    try {
      const settings = settingsOf(plan)
      expect(settings['permissions']).toEqual({ deny: ['Edit', 'Write', 'NotebookEdit', 'Bash'] })
      expect(Object.keys(settings['hooks'] as object)).toContain('Stop')
      expect(plan.args).toContain('--mcp-config')
      expect(plan.args).not.toContain('--permission-mode')
      expect(REVIEW_COMPANION_DENY.some((tool) => tool.startsWith('mcp__'))).toBe(false)
    } finally {
      plan.cleanup?.()
    }
  })

  it('adds the checkout dir before the session flags, so the variadic flag cannot take the prompt', () => {
    const plan = claudeProvider.buildLaunch({ terminalId: 'c2', worktreePath: '/repo', ...bridge, reviewCompanion: companion, initialPrompt: 'brief' })
    try {
      const at = plan.args.indexOf('--add-dir')
      expect(plan.args[at + 1]).toBe(companion.extraReadDir)
      expect(plan.args[at + 2]).toBe('--session-id')
      expect(plan.args.at(-1)).toBe('brief')
    } finally {
      plan.cleanup?.()
    }
  })

  it('still denies writes when no bridge is up', () => {
    const plan = claudeProvider.buildLaunch({ terminalId: 'c3', worktreePath: '/repo', reviewCompanion: companion })
    try {
      const settings = settingsOf(plan)
      expect(settings['permissions']).toEqual({ deny: [...REVIEW_COMPANION_DENY] })
      expect(settings['hooks']).toBeUndefined()
      expect(plan.args).not.toContain('--mcp-config')
    } finally {
      plan.cleanup?.()
    }
  })

  it('leaves a normal session as it was', () => {
    const plan = claudeProvider.buildLaunch({ terminalId: 'c4', worktreePath: '/repo', ...bridge })
    try {
      expect(settingsOf(plan)['permissions']).toBeUndefined()
      expect(plan.args).not.toContain('--add-dir')
    } finally {
      plan.cleanup?.()
    }
    expect(claudeProvider.buildLaunch({ terminalId: 'c5', worktreePath: '/repo' }).args).not.toContain('--settings')
  })
})

describe('Codex companion launch', () => {
  it('runs in the read-only sandbox, keeping the default approval policy', () => {
    const plan = codexProvider.buildLaunch({ terminalId: 'x1', worktreePath: '/repo', ...bridge, reviewCompanion: companion }) as LaunchPlan
    const at = plan.args.indexOf('--sandbox')
    expect(plan.args[at + 1]).toBe('read-only')
    expect(plan.args.join(' ')).not.toMatch(/approval|dangerously|--full-auto/)
    expect(plan.args.join(' ')).toContain('mcp_servers.simpleedit')
  })

  it('leaves a normal session as it was', () => {
    const plan = codexProvider.buildLaunch({ terminalId: 'x2', worktreePath: '/repo', ...bridge }) as LaunchPlan
    expect(plan.args).not.toContain('--sandbox')
  })
})

describe('OpenCode companion launch', () => {
  async function launch(ctx: Partial<LaunchContext>): Promise<LaunchPlan> {
    return opencodeProvider.buildLaunch({ terminalId: 'o1', worktreePath: '/repo', ...bridge, ...ctx })
  }

  it('denies edits, shell, fetch and sub-agents, and allows only the checkout dir outside the project', async () => {
    const plan = await launch({ reviewCompanion: companion })
    try {
      const permission = JSON.parse(plan.env!['OPENCODE_PERMISSION']!) as Record<string, unknown>
      expect(permission).toMatchObject({ edit: 'deny', bash: 'deny', webfetch: 'deny', task: 'deny', read: 'allow' })
      const external = permission['external_directory'] as Record<string, string>
      expect(Object.keys(external)[0]).toBe('*')
      expect(external['*']).toBe('deny')
      expect(external[`${companion.extraReadDir}/*`]).toBe('allow')
      expect(external[`${companion.extraReadDir}/**`]).toBe('allow')
      const config = JSON.parse(plan.env!['OPENCODE_CONFIG_CONTENT']!) as { mcp: { simpleedit: { enabled: boolean } } }
      expect(config.mcp.simpleedit.enabled).toBe(true)
    } finally {
      plan.cleanup?.()
    }
  })

  it('leaves a normal session as it was', async () => {
    const plan = await launch({})
    try {
      expect(plan.env!['OPENCODE_PERMISSION']).toBeUndefined()
    } finally {
      plan.cleanup?.()
    }
  })
})

describe('read-only claim per provider', () => {
  it('is stated for every provider', () => {
    expect([claudeProvider, codexProvider, opencodeProvider].map((p) => p.reviewCompanionReadOnly)).toEqual(['enforced', 'enforced', 'enforced'])
  })
})
