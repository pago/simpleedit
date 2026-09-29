import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// `agents/claude` reads `app` for the packaged MCP-server path; a launch built
// with a bridge never reaches it.
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app' } }))

import { startBridge, stopAllBridges, getBridgeInfo, setWorktreeResolver } from '../mcp-bridge'
import { registerSession, unregisterTerminal } from '../cwd-tracker'
import { claudeProvider } from '../agents/claude'
import { readFileSync } from 'fs'
import type { AgentProviderId, AgentStatusEvent, WorktreeInfo } from '../../shared/ipc-types'

/**
 * Every provider we claim to notify for must have a demonstrated path to
 * `waiting`.
 *
 * This file exists because the claim was false. `push.ts` fires on
 * `agent:status` → `waiting`, the Remote access pane and the changeset both
 * said "covers every provider", and a Claude session could not reach that
 * status by any route: its OSC-title parser produces only `idle` and
 * `running`, and the hooks it launched with were `UserPromptSubmit`,
 * `PostToolUse` and `Stop` — never `Notification`, the one Claude Code fires
 * when it actually needs you.
 *
 * So this is not a test of push. It is the coverage claim itself, written down
 * per provider and wired to the real code, so that removing any provider's
 * path fails here rather than silently making the copy a lie again.
 */

function makeWebContents(): { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> } {
  return { isDestroyed: () => false, send: vi.fn() }
}

function statusEvents(wc: { send: ReturnType<typeof vi.fn> }): AgentStatusEvent[] {
  return wc.send.mock.calls
    .filter(([channel]) => channel === 'agent:status')
    .map(([, payload]) => payload as AgentStatusEvent)
}

/** The one thing a push is allowed to fire on. */
function blockedSignals(wc: { send: ReturnType<typeof vi.fn> }): AgentStatusEvent[] {
  return statusEvents(wc).filter((event) => event.status === 'waiting' && event.precise)
}

let windowId = 900

afterEach(() => {
  stopAllBridges()
  windowId++
})

describe('every provider reaches `waiting`', () => {
  let port: number
  let token: string
  let wc: ReturnType<typeof makeWebContents>

  beforeEach(async () => {
    wc = makeWebContents()
    port = await startBridge(windowId, wc as never)
    token = getBridgeInfo(windowId)!.token
    const worktrees: WorktreeInfo[] = [{ path: '/repo/feature', branch: 'b', isMain: false, isCurrent: false }]
    setWorktreeResolver(async () => worktrees)
  })

  afterEach(() => {
    setWorktreeResolver(async () => [])
    unregisterTerminal('term-claude')
    unregisterTerminal('term-codex')
  })

  async function postHook(body: unknown): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}/${token}/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.status
  }

  /**
   * Claude Code's `Notification` hook is the ONLY signal it emits that means
   * "I need you" — it fires when a tool needs permission, and when the prompt
   * has sat idle waiting for input. Neither reaches the OSC title, so without
   * this hook a Claude session is silent by construction.
   */
  it('claude: a Notification hook becomes a precise `waiting`', async () => {
    registerSession('sess-claude', 'term-claude')
    expect(await postHook({
      session_id: 'sess-claude',
      cwd: '/repo/feature',
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    })).toBe(200)

    expect(blockedSignals(wc)).toEqual([
      {
        worktreePath: '/repo/feature',
        status: 'waiting',
        terminalId: 'term-claude',
        precise: true,
        message: 'Claude needs your permission to use Bash',
      },
    ])
  })

  /**
   * The hook has to be WIRED, not merely handled. A handler with nothing
   * pointed at it is the exact shape of the bug this file was written for.
   */
  it('claude: every launch wires the Notification hook', () => {
    const plan = claudeProvider.buildLaunch({
      terminalId: 'term-claude',
      worktreePath: '/repo/feature',
      bridgePort: port,
      bridgeToken: token,
    })
    const settingsIndex = plan.args.indexOf('--settings')
    expect(settingsIndex).toBeGreaterThanOrEqual(0)
    const settings = JSON.parse(readFileSync(plan.args[settingsIndex + 1], 'utf8')) as {
      hooks: Record<string, { hooks: { url: string }[] }[]>
    }
    expect(Object.keys(settings.hooks).sort()).toContain('Notification')
    // Pointed at the same bridge endpoint as the rest, or it is wired to nothing.
    expect(settings.hooks.Notification[0].hooks[0].url).toContain(`/${token}/hooks`)
  })

  /**
   * Claude reports `idle` when a turn ends and it has nothing to ask. That is
   * not being blocked on the user, and a push for it would be the phantom buzz
   * this whole feature is built to avoid.
   */
  it('claude: an ordinary turn produces no blocked signal', async () => {
    registerSession('sess-claude', 'term-claude')
    await postHook({ session_id: 'sess-claude', cwd: '/repo/feature', hook_event_name: 'UserPromptSubmit' })
    await postHook({ session_id: 'sess-claude', cwd: '/repo/feature', hook_event_name: 'PostToolUse' })
    await postHook({ session_id: 'sess-claude', cwd: '/repo/feature', hook_event_name: 'Stop' })
    expect(blockedSignals(wc)).toEqual([])
  })

  it('codex: a PermissionRequest hook becomes a precise `waiting`', async () => {
    expect(await postHook({
      session_id: 'sess-codex',
      simpleedit_terminal_id: 'term-codex',
      cwd: '/repo/feature',
      hook_event_name: 'PermissionRequest',
    })).toBe(200)

    expect(blockedSignals(wc)).toEqual([
      { worktreePath: '/repo/feature', status: 'waiting', terminalId: 'term-codex', precise: true },
    ])
  })

  /**
   * The list the copy is allowed to name, and where each one's path is proved.
   * A provider registered without an entry here fails before its absence can
   * reach a user-facing sentence.
   */
  it('every registered provider has a proved path to `waiting`', async () => {
    const { registeredProviderIds } = await import('../agents/provider')
    await import('../agents/codex')
    await import('../agents/opencode')

    const proved: Record<AgentProviderId, string> = {
      claude: 'the Notification hook — proved above',
      codex: 'the PermissionRequest hook — proved above',
      // OpenCode has no hooks; its control channel translates the event into
      // the same signal, and that translation is exercised where it lives.
      opencode: 'agents/__tests__/opencode.test.ts — permission.asked → waiting',
    }
    for (const id of registeredProviderIds()) {
      expect(proved[id], `${id} is registered but has no proved path to waiting`).toBeTruthy()
    }
    expect(registeredProviderIds().length).toBeGreaterThanOrEqual(3)
  })
})
