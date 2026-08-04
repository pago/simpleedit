import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'child_process'
import { spawn } from 'child_process'
import { join } from 'path'
import { startBridge, stopBridge, getBridgeInfo, stopAllBridges, setWorktreeResolver, setRepoDiscoverer } from '../mcp-bridge'
import { attachToTerminal, detachFromTerminal } from '../claude-stream'
import { registerSession, unregisterTerminal } from '../cwd-tracker'
import type { WorktreeInfo } from '../../shared/ipc-types'

function makeWebContents() {
  return { isDestroyed: vi.fn(() => false), send: vi.fn() }
}

let bridgeWebContentsId = 100

afterEach(() => {
  stopAllBridges()
  bridgeWebContentsId++
})

describe('MCP Bridge — server lifecycle', () => {
  it('starts on a random port and returns a valid port number', async () => {
    const wc = makeWebContents()
    const port = await startBridge(bridgeWebContentsId, wc as never)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
  })

  it('returns the same port when called twice with the same webContentsId', async () => {
    const wc = makeWebContents()
    const port1 = await startBridge(bridgeWebContentsId, wc as never)
    const port2 = await startBridge(bridgeWebContentsId, wc as never)
    expect(port1).toBe(port2)
  })

  it('getBridgeInfo returns port and token after start', async () => {
    const wc = makeWebContents()
    await startBridge(bridgeWebContentsId, wc as never)
    const info = getBridgeInfo(bridgeWebContentsId)
    expect(info).not.toBeNull()
    expect(info!.port).toBeGreaterThan(0)
    expect(info!.token).toMatch(/^[a-f0-9]{32}$/)
  })

  it('getBridgeInfo returns null after stop', async () => {
    const wc = makeWebContents()
    await startBridge(bridgeWebContentsId, wc as never)
    stopBridge(bridgeWebContentsId)
    expect(getBridgeInfo(bridgeWebContentsId)).toBeNull()
  })

  it('port is released after stop (can rebind)', async () => {
    const wc = makeWebContents()
    await startBridge(bridgeWebContentsId, wc as never)
    stopBridge(bridgeWebContentsId)
    // Starting again should succeed (port released)
    const port = await startBridge(bridgeWebContentsId, wc as never)
    expect(port).toBeGreaterThan(0)
  })
})

describe('MCP Bridge — HTTP endpoints', () => {
  let port: number
  let token: string
  let wc: ReturnType<typeof makeWebContents>

  beforeEach(async () => {
    wc = makeWebContents()
    port = await startBridge(bridgeWebContentsId, wc as never)
    const info = getBridgeInfo(bridgeWebContentsId)!
    token = info.token
  })

  async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json() as Record<string, unknown>
    return { status: res.status, body: json }
  }

  it('returns 404 for wrong token path', async () => {
    const res = await post('/wrong-token/tool-call', {
      tool: 'complete_task',
      terminalId: 'term-1',
      args: {},
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 for missing tool field', async () => {
    const res = await post(`/${token}/tool-call`, {
      terminalId: 'term-1',
      args: {},
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('tool')
  })

  it('returns 400 for missing terminalId', async () => {
    const res = await post(`/${token}/tool-call`, {
      tool: 'complete_task',
      args: {},
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('terminalId')
  })

  it('returns 400 for unknown tool', async () => {
    const res = await post(`/${token}/tool-call`, {
      tool: 'unknown_tool',
      terminalId: 'term-1',
      args: {},
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Unknown tool')
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/${token}/tool-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  describe('complete_task', () => {
    const baseTour = {
      overview: 'Did the thing',
      topics: [
        {
          title: 'Topic one',
          summary: 'Explains topic one',
          segments: [
            { prose: 'First segment prose', file: 'src/foo.ts', lineRange: [1, 10] },
          ],
        },
      ],
    }

    it('emits tour:from-claude with commitHash=null when commitHash omitted', async () => {
      const res = await post(`/${token}/tool-call`, {
        tool: 'complete_task',
        terminalId: 'term-42',
        args: {
          worktreePath: '/test/repo',
          tour: baseTour,
          openQuestions: ['Should X?', 'What about Y?'],
        },
      })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(wc.send).toHaveBeenCalledWith(
        'tour:from-claude',
        expect.objectContaining({
          key: '/test/repo:staging',
          terminalId: 'term-42',
          worktreePath: '/test/repo',
          commitHash: null,
          tour: expect.objectContaining({
            overview: baseTour.overview,
            openQuestions: ['Should X?', 'What about Y?'],
          }),
        })
      )
    })

    it('emits tour:from-claude with the provided commitHash', async () => {
      const res = await post(`/${token}/tool-call`, {
        tool: 'complete_task',
        terminalId: 'term-7',
        args: {
          worktreePath: '/test/repo',
          commitHash: 'abc123',
          tour: baseTour,
        },
      })

      expect(res.status).toBe(200)
      expect(wc.send).toHaveBeenCalledWith(
        'tour:from-claude',
        expect.objectContaining({
          key: '/test/repo:abc123',
          terminalId: 'term-7',
          worktreePath: '/test/repo',
          commitHash: 'abc123',
          tour: expect.objectContaining({ overview: baseTour.overview }),
        })
      )
    })

    it('treats empty openQuestions array as absent in the persisted tour payload', async () => {
      await post(`/${token}/tool-call`, {
        tool: 'complete_task',
        terminalId: 'term-1',
        args: {
          worktreePath: '/test/repo',
          tour: baseTour,
          openQuestions: [],
        },
      })

      expect(wc.send).toHaveBeenCalledWith(
        'tour:from-claude',
        expect.objectContaining({
          tour: expect.not.objectContaining({ openQuestions: expect.anything() }),
        })
      )
    })

    it('treats empty-string commitHash as staging', async () => {
      await post(`/${token}/tool-call`, {
        tool: 'complete_task',
        terminalId: 'term-1',
        args: {
          worktreePath: '/test/repo',
          commitHash: '',
          tour: baseTour,
        },
      })

      expect(wc.send).toHaveBeenCalledWith(
        'tour:from-claude',
        expect.objectContaining({ commitHash: null, key: '/test/repo:staging' })
      )
    })

    it('returns 400 when tour is missing', async () => {
      const res = await post(`/${token}/tool-call`, {
        tool: 'complete_task',
        terminalId: 'term-1',
        args: { worktreePath: '/test/repo' },
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 when worktreePath cannot be resolved', async () => {
      const res = await post(`/${token}/tool-call`, {
        tool: 'complete_task',
        terminalId: 'term-1',
        args: { tour: baseTour },
      })
      expect(res.status).toBe(400)
    })

    it('does not emit IPC when webContents is destroyed', async () => {
      wc.isDestroyed.mockReturnValue(true)

      const res = await post(`/${token}/tool-call`, {
        tool: 'complete_task',
        terminalId: 'term-1',
        args: { worktreePath: '/test/repo', tour: baseTour },
      })

      expect(res.status).toBe(200)
      expect(wc.send).not.toHaveBeenCalled()
    })

    it('uses the authoritative terminal→worktree mapping over arg-supplied worktreePath', async () => {
      const terminalId = 'term-auth'
      attachToTerminal(terminalId, '/authoritative/worktree', wc as never)

      try {
        const res = await post(`/${token}/tool-call`, {
          tool: 'complete_task',
          terminalId,
          args: {
            worktreePath: '/evil/path',
            tour: baseTour,
          },
        })

        expect(res.status).toBe(200)
        expect(wc.send).toHaveBeenCalledWith(
          'tour:from-claude',
          expect.objectContaining({
            worktreePath: '/authoritative/worktree',
            key: '/authoritative/worktree:staging',
          })
        )
      } finally {
        detachFromTerminal(terminalId)
      }
    })

    it('assigns stable topic ids on the persisted/emitted tour', async () => {
      await post(`/${token}/tool-call`, {
        tool: 'complete_task',
        terminalId: 'term-ids',
        args: {
          worktreePath: '/test/repo',
          tour: {
            overview: 'x',
            topics: [
              { title: 'Topic A', summary: 'a', segments: [{ prose: 'p', file: 'f', lineRange: [1, 1] }] },
              { title: 'Topic B', summary: 'b', segments: [{ prose: 'p', file: 'f', lineRange: [1, 1] }] },
            ],
          },
        },
      })

      const call = wc.send.mock.calls.find((c: unknown[]) => c[0] === 'tour:from-claude')
      expect(call).toBeDefined()
      const payload = call![1] as { tour: { topics: Array<{ id: string }> } }
      expect(payload.tour.topics).toHaveLength(2)
      expect(payload.tour.topics[0].id).toBe('/test/repo:staging:topic-0')
      expect(payload.tour.topics[1].id).toBe('/test/repo:staging:topic-1')
    })
  })
})

describe('MCP Bridge — location-tracking hooks', () => {
  let port: number
  let token: string
  let wc: ReturnType<typeof makeWebContents>

  function wtList(...paths: string[]): WorktreeInfo[] {
    return paths.map((p) => ({ path: p, branch: 'b', isMain: false, isCurrent: false }))
  }

  beforeEach(async () => {
    wc = makeWebContents()
    port = await startBridge(bridgeWebContentsId, wc as never)
    token = getBridgeInfo(bridgeWebContentsId)!.token
    setWorktreeResolver(async () => wtList('/repo/main', '/repo/feature'))
  })

  afterEach(() => {
    setWorktreeResolver(async () => [])
    setRepoDiscoverer(async () => null)
    unregisterTerminal('hook-term')
  })

  async function postHook(body: unknown): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}/${token}/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return res.status
  }

  it('routes a hook to its terminal and matches the cwd to a worktree', async () => {
    registerSession('sess-h', 'hook-term')
    const status = await postHook({
      session_id: 'sess-h',
      cwd: '/repo/feature/src',
      hook_event_name: 'PostToolUse',
    })
    expect(status).toBe(200)
    expect(wc.send).toHaveBeenCalledWith('session:cwd', {
      terminalId: 'hook-term',
      cwd: '/repo/feature/src',
      worktreePath: '/repo/feature',
      repoPath: null,
    })
  })

  it('emits worktreePath + repoPath null when cwd is outside every worktree and no repo is discoverable', async () => {
    registerSession('sess-h', 'hook-term')
    await postHook({ session_id: 'sess-h', cwd: '/somewhere/else', hook_event_name: 'UserPromptSubmit' })
    expect(wc.send).toHaveBeenCalledWith('session:cwd', {
      terminalId: 'hook-term',
      cwd: '/somewhere/else',
      worktreePath: null,
      repoPath: null,
    })
  })

  it('discovers an unopened repo from the cwd and re-matches its worktree', async () => {
    // The agent roamed into /other-repo, which the window never opened, so the
    // primary resolver misses. The discoverer resolves + lists it, and the hook
    // re-matches the cwd against the discovered worktrees.
    registerSession('sess-h', 'hook-term')
    setRepoDiscoverer(async (_id, cwd) => {
      if (!cwd.startsWith('/other-repo')) return null
      return { repoPath: '/other-repo/.bare', worktrees: wtList('/other-repo/backend') }
    })
    await postHook({ session_id: 'sess-h', cwd: '/other-repo/backend/src', hook_event_name: 'PostToolUse' })
    expect(wc.send).toHaveBeenCalledWith('session:cwd', {
      terminalId: 'hook-term',
      cwd: '/other-repo/backend/src',
      worktreePath: '/other-repo/backend',
      repoPath: '/other-repo/.bare',
    })
  })

  it('records a cross-repo file touch as session:repo-touch (agent read/edited without cd)', async () => {
    // cwd stays in the opened repo (/repo/feature), but the agent edited a file
    // in a sibling repo it never cd'd into. The discoverer resolves the sibling
    // from the file's directory; we emit a repo-touch so it joins the trail.
    registerSession('sess-h', 'hook-term')
    setRepoDiscoverer(async (_id, location) => {
      if (!location.startsWith('/other-repo')) return null
      return { repoPath: '/other-repo/.bare', worktrees: wtList('/other-repo/backend') }
    })
    await postHook({
      session_id: 'sess-h',
      cwd: '/repo/feature/src',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/other-repo/backend/src/app.ts' },
    })
    // cwd still resolves to the opened worktree (view-following signal)...
    expect(wc.send).toHaveBeenCalledWith('session:cwd', {
      terminalId: 'hook-term',
      cwd: '/repo/feature/src',
      worktreePath: '/repo/feature',
      repoPath: null,
    })
    // ...and the touched file surfaces the sibling repo (trail-only signal).
    expect(wc.send).toHaveBeenCalledWith('session:repo-touch', {
      terminalId: 'hook-term',
      worktreePath: '/other-repo/backend',
      repoPath: '/other-repo/.bare',
    })
  })

  it('does not emit session:repo-touch when the touched file is in the cwd worktree', async () => {
    registerSession('sess-h', 'hook-term')
    await postHook({
      session_id: 'sess-h',
      cwd: '/repo/feature',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/repo/feature/src/app.ts' },
    })
    const touchCalls = wc.send.mock.calls.filter((c: unknown[]) => c[0] === 'session:repo-touch')
    expect(touchCalls).toHaveLength(0)
  })

  it('does not emit session:repo-touch for a non-file hook (no file_path)', async () => {
    registerSession('sess-h', 'hook-term')
    await postHook({
      session_id: 'sess-h',
      cwd: '/repo/feature',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    })
    const touchCalls = wc.send.mock.calls.filter((c: unknown[]) => c[0] === 'session:repo-touch')
    expect(touchCalls).toHaveLength(0)
  })

  it('still returns 200 (and emits nothing) for an unregistered session', async () => {
    const status = await postHook({ session_id: 'unknown', cwd: '/repo/main' })
    expect(status).toBe(200)
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('returns 200 for a malformed body without throwing', async () => {
    expect(await postHook('not json')).toBe(200)
    expect(await postHook({ cwd: '/repo/main' })).toBe(200) // missing session_id
    expect(wc.send).not.toHaveBeenCalled()
  })
})

describe('MCP Bridge — open_worktree / show_diff tools', () => {
  let port: number
  let token: string
  let wc: ReturnType<typeof makeWebContents>

  function wtList(...paths: string[]): WorktreeInfo[] {
    return paths.map((p) => ({ path: p, branch: p.split('/').pop()!, isMain: false, isCurrent: false }))
  }

  beforeEach(async () => {
    wc = makeWebContents()
    port = await startBridge(bridgeWebContentsId, wc as never)
    token = getBridgeInfo(bridgeWebContentsId)!.token
    setWorktreeResolver(async () => wtList('/repo/main', '/repo/feature'))
  })

  afterEach(() => {
    setWorktreeResolver(async () => [])
  })

  async function post(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}/${token}/tool-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it('open_worktree by path emits the IPC event', async () => {
    const res = await post({ tool: 'open_worktree', terminalId: 'term-1', args: { worktreePath: '/repo/feature' } })
    expect(res.status).toBe(200)
    expect(wc.send).toHaveBeenCalledWith('agent-workspace:open-worktree', {
      sourceTerminalId: 'term-1',
      worktreePath: '/repo/feature',
    })
  })

  it('open_worktree by branch resolves to the worktree path', async () => {
    const res = await post({ tool: 'open_worktree', terminalId: 'term-1', args: { branch: 'feature' } })
    expect(res.status).toBe(200)
    expect(wc.send).toHaveBeenCalledWith('agent-workspace:open-worktree', {
      sourceTerminalId: 'term-1',
      worktreePath: '/repo/feature',
    })
  })

  it('open_worktree returns 400 with the worktree list for an unknown target', async () => {
    const res = await post({ tool: 'open_worktree', terminalId: 'term-1', args: { worktreePath: '/repo/nope' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('No worktree matches')
  })

  it('open_worktree returns 400 when neither path nor branch given', async () => {
    const res = await post({ tool: 'open_worktree', terminalId: 'term-1', args: {} })
    expect(res.status).toBe(400)
  })

  it('show_diff defaults commitHash to null (staging)', async () => {
    const res = await post({ tool: 'show_diff', terminalId: 'term-1', args: { worktreePath: '/repo/main' } })
    expect(res.status).toBe(200)
    expect(wc.send).toHaveBeenCalledWith('agent-workspace:show-diff', {
      sourceTerminalId: 'term-1',
      worktreePath: '/repo/main',
      commitHash: null,
    })
  })

  it('show_diff maps "staging" and "" to null', async () => {
    await post({ tool: 'show_diff', terminalId: 'term-1', args: { worktreePath: '/repo/main', commitHash: 'staging' } })
    expect(wc.send).toHaveBeenLastCalledWith('agent-workspace:show-diff', expect.objectContaining({ commitHash: null }))
    await post({ tool: 'show_diff', terminalId: 'term-1', args: { worktreePath: '/repo/main', commitHash: '' } })
    expect(wc.send).toHaveBeenLastCalledWith('agent-workspace:show-diff', expect.objectContaining({ commitHash: null }))
  })

  it('show_diff passes through "branch" and a SHA', async () => {
    await post({ tool: 'show_diff', terminalId: 'term-1', args: { worktreePath: '/repo/main', commitHash: 'branch' } })
    expect(wc.send).toHaveBeenLastCalledWith('agent-workspace:show-diff', expect.objectContaining({ commitHash: 'branch' }))
    await post({ tool: 'show_diff', terminalId: 'term-1', args: { worktreePath: '/repo/main', commitHash: 'deadbeef' } })
    expect(wc.send).toHaveBeenLastCalledWith('agent-workspace:show-diff', expect.objectContaining({ commitHash: 'deadbeef' }))
  })

  it('show_diff rejects a worktreePath that is not in the repo', async () => {
    const res = await post({ tool: 'show_diff', terminalId: 'term-1', args: { worktreePath: '/evil/path' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('not a worktree')
  })

  it('show_diff falls back to the terminal→worktree mapping when no path given', async () => {
    attachToTerminal('term-attached', '/repo/main', wc as never)
    try {
      const res = await post({ tool: 'show_diff', terminalId: 'term-attached', args: {} })
      expect(res.status).toBe(200)
      expect(wc.send).toHaveBeenCalledWith('agent-workspace:show-diff', {
        sourceTerminalId: 'term-attached',
        worktreePath: '/repo/main',
        commitHash: null,
      })
    } finally {
      detachFromTerminal('term-attached')
    }
  })

  it('spawn_session emits agent-session:spawn with the brief and caller terminal', async () => {
    const res = await post({ tool: 'spawn_session', terminalId: 'term-1', args: { brief: 'fix the timeline reducer' } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(wc.send).toHaveBeenCalledWith('agent-session:spawn', {
      sourceTerminalId: 'term-1',
      brief: 'fix the timeline reducer',
      target: 'new-pane',
    })
  })

  it('spawn_session forwards label, model, a validated worktree, and target', async () => {
    const res = await post({
      tool: 'spawn_session',
      terminalId: 'term-1',
      args: { brief: 'rebase #42', label: 'rebase', model: 'claude-opus-4-8', worktree: '/repo/feature', target: 'replace' },
    })
    expect(res.status).toBe(200)
    expect(wc.send).toHaveBeenCalledWith('agent-session:spawn', {
      sourceTerminalId: 'term-1',
      brief: 'rebase #42',
      label: 'rebase',
      model: 'claude-opus-4-8',
      worktreePath: '/repo/feature',
      target: 'replace',
    })
  })

  it('spawn_session defaults an unknown/absent target to new-pane', async () => {
    await post({ tool: 'spawn_session', terminalId: 'term-1', args: { brief: 'x', target: 'bogus' } })
    expect(wc.send).toHaveBeenLastCalledWith('agent-session:spawn', expect.objectContaining({ target: 'new-pane' }))
  })

  it('spawn_session returns 400 for a missing/blank brief', async () => {
    expect((await post({ tool: 'spawn_session', terminalId: 'term-1', args: {} })).status).toBe(400)
    expect((await post({ tool: 'spawn_session', terminalId: 'term-1', args: { brief: '   ' } })).status).toBe(400)
  })

  it('spawn_session rejects a worktree that is not in the repo', async () => {
    const res = await post({ tool: 'spawn_session', terminalId: 'term-1', args: { brief: 'x', worktree: '/evil/path' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('No worktree matches')
  })

  describe('show_panel', () => {
    const SPEC = {
      root: 'r',
      elements: { r: { type: 'ProseBlock', props: { content: 'hi' } } },
    }

    it('prefers the agent-supplied worktreePath over the frozen terminal mapping', async () => {
      // The terminal→worktree map is written once at session start, so trusting
      // it first silently rendered cross-repo panels against the wrong worktree.
      attachToTerminal('term-panel', '/repo/main', wc as never)
      try {
        const res = await post({
          tool: 'show_panel',
          terminalId: 'term-panel',
          args: { worktreePath: '/repo/feature', spec: SPEC },
        })
        expect(res.status).toBe(200)
        expect(wc.send).toHaveBeenCalledWith(
          'agent-panel:open',
          expect.objectContaining({ worktreePath: '/repo/feature', sourceTerminalId: 'term-panel' }),
        )
      } finally {
        detachFromTerminal('term-panel')
      }
    })

    it('falls back to the terminal mapping when no worktreePath is given', async () => {
      attachToTerminal('term-panel', '/repo/main', wc as never)
      try {
        const res = await post({ tool: 'show_panel', terminalId: 'term-panel', args: { spec: SPEC } })
        expect(res.status).toBe(200)
        expect(wc.send).toHaveBeenCalledWith(
          'agent-panel:open',
          expect.objectContaining({ worktreePath: '/repo/main' }),
        )
      } finally {
        detachFromTerminal('term-panel')
      }
    })

    it('rejects a worktreePath outside the window union and returns the available list', async () => {
      const res = await post({
        tool: 'show_panel',
        terminalId: 'term-1',
        args: { worktreePath: '/evil/path', spec: SPEC },
      })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('not a worktree')
      expect(res.body.worktrees).toEqual(['/repo/main', '/repo/feature'])
      expect(wc.send).not.toHaveBeenCalled()
    })

    it('forwards an agent-supplied panelId so panels can coexist', async () => {
      const res = await post({
        tool: 'show_panel',
        terminalId: 'term-1',
        args: { worktreePath: '/repo/main', panelId: 'tour-1', spec: SPEC },
      })
      expect(res.status).toBe(200)
      expect(wc.send).toHaveBeenCalledWith(
        'agent-panel:open',
        expect.objectContaining({ panelId: 'tour-1' }),
      )
    })

    it('omits panelId entirely when absent (replace-in-place stays the default)', async () => {
      await post({ tool: 'show_panel', terminalId: 'term-1', args: { worktreePath: '/repo/main', spec: SPEC } })
      const payload = wc.send.mock.calls.at(-1)![1] as Record<string, unknown>
      expect('panelId' in payload).toBe(false)
    })

    it('rejects a panelId that would not survive as a tab id', async () => {
      const res = await post({
        tool: 'show_panel',
        terminalId: 'term-1',
        args: { worktreePath: '/repo/main', panelId: 'tour/../../etc', spec: SPEC },
      })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('panelId')
    })

    it('rejects an action naming a worktree outside the union', async () => {
      const res = await post({
        tool: 'show_panel',
        terminalId: 'term-1',
        args: {
          worktreePath: '/repo/main',
          spec: {
            root: 'b',
            elements: {
              b: {
                type: 'ActionButton',
                props: {
                  label: 'open',
                  action: { type: 'open_file', worktree: '/evil/repo', path: 'a.ts' },
                },
              },
            },
          },
        },
      })
      expect(res.status).toBe(400)
      expect(res.body.issues).toBeDefined()
    })

    it('accepts an action scoped to another worktree of the window', async () => {
      const res = await post({
        tool: 'show_panel',
        terminalId: 'term-1',
        args: {
          worktreePath: '/repo/main',
          spec: {
            root: 'b',
            elements: {
              b: {
                type: 'ActionButton',
                props: {
                  label: 'open',
                  action: { type: 'open_file', worktree: '/repo/feature', path: 'a.ts' },
                },
              },
            },
          },
        },
      })
      expect(res.status).toBe(200)
    })
  })
})

// These tests spawn the real built MCP server (out/mcp-server/index.mjs) and
// drive it over stdio, so they need the build artifact and are sensitive to
// resource contention. Under the combined `pnpm test` run they race the browser
// project's Chromium boot and time out with "MCP response timeout", while
// passing cleanly in isolation (#96). They add no coverage the rest of the
// suite or CI relies on, so they're opt-in: run them with `pnpm test:integration`
// (which sets RUN_MCP_INTEGRATION). Without that flag — including in the default
// `pnpm test`, `pnpm test:unit`, and CI — they're skipped.
const runIntegration = !!process.env.RUN_MCP_INTEGRATION

describe.skipIf(!runIntegration)('MCP Server → Bridge integration', () => {
  const MCP_SERVER_PATH = join(__dirname, '..', '..', '..', 'out', 'mcp-server', 'index.mjs')
  let port: number
  let token: string
  let wc: ReturnType<typeof makeWebContents>
  let mcpProc: ChildProcess | null = null

  beforeEach(async () => {
    wc = makeWebContents()
    port = await startBridge(bridgeWebContentsId, wc as never)
    const info = getBridgeInfo(bridgeWebContentsId)!
    token = info.token
  })

  afterEach(() => {
    if (mcpProc && !mcpProc.killed) {
      mcpProc.kill()
    }
    mcpProc = null
  })

  /** Send a JSON-RPC message to the MCP server via stdin and read the response from stdout. */
  function sendMcpMessage(proc: ChildProcess, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MCP response timeout')), 10000)
      let buf = ''

      function onData(chunk: Buffer): void {
        buf += chunk.toString()
        // MCP protocol: messages are separated by newlines
        const lines = buf.split('\n')
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>
            clearTimeout(timeout)
            proc.stdout!.off('data', onData)
            resolve(parsed)
            return
          } catch {
            // Not a complete JSON line yet
          }
        }
      }

      proc.stdout!.on('data', onData)
      proc.stdin!.write(JSON.stringify(message) + '\n')
    })
  }

  it('MCP server complete_task call flows through to bridge IPC', async () => {
    mcpProc = spawn('node', [MCP_SERVER_PATH], {
      env: {
        ...process.env,
        SIMPLEEDIT_BRIDGE_PORT: String(port),
        SIMPLEEDIT_BRIDGE_TOKEN: token,
        SIMPLEEDIT_TERMINAL_ID: 'tour-test-term',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    await new Promise((resolve) => setTimeout(resolve, 500))

    const initResponse = await sendMcpMessage(mcpProc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    })
    expect(initResponse['id']).toBe(1)
    expect(initResponse['result']).toBeDefined()

    mcpProc.stdin!.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n')

    await new Promise((resolve) => setTimeout(resolve, 200))

    const tour = {
      overview: 'Refactored auth middleware',
      topics: [
        {
          title: 'Extract token parser',
          summary: 'Move token parsing into its own helper',
          segments: [
            { prose: 'New helper function', file: 'src/auth/parse.ts', lineRange: [1, 20] },
          ],
        },
      ],
    }

    const toolResponse = await sendMcpMessage(mcpProc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'complete_task',
        arguments: {
          worktreePath: '/integration/repo',
          tour,
          openQuestions: ['Should we also handle legacy tokens?'],
        },
      },
    })

    expect(toolResponse['id']).toBe(2)
    const result = toolResponse['result'] as Record<string, unknown>
    expect(result).toBeDefined()
    const content = result['content'] as Array<{ type: string; text: string }>
    expect(content[0].text).toContain('Tour delivered')

    expect(wc.send).toHaveBeenCalledWith(
      'tour:from-claude',
      expect.objectContaining({
        key: '/integration/repo:staging',
        terminalId: 'tour-test-term',
        worktreePath: '/integration/repo',
        commitHash: null,
        tour: expect.objectContaining({
          overview: tour.overview,
          openQuestions: ['Should we also handle legacy tokens?'],
        }),
      })
    )
  }, 15000)

  it('MCP server spawn_session call flows through to bridge IPC', async () => {
    mcpProc = spawn('node', [MCP_SERVER_PATH], {
      env: {
        ...process.env,
        SIMPLEEDIT_BRIDGE_PORT: String(port),
        SIMPLEEDIT_BRIDGE_TOKEN: token,
        SIMPLEEDIT_TERMINAL_ID: 'spawn-test-term',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    await new Promise((resolve) => setTimeout(resolve, 500))

    await sendMcpMessage(mcpProc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    })
    mcpProc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    await new Promise((resolve) => setTimeout(resolve, 200))

    // tools/list must advertise spawn_session so an agent can discover it.
    const listResponse = await sendMcpMessage(mcpProc, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const tools = (listResponse['result'] as { tools: Array<{ name: string }> }).tools
    expect(tools.map((t) => t.name)).toContain('spawn_session')

    const toolResponse = await sendMcpMessage(mcpProc, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'spawn_session', arguments: { brief: 'rebase and land PR #42', label: 'rebase' } },
    })

    expect(toolResponse['id']).toBe(3)
    const content = (toolResponse['result'] as { content: Array<{ text: string }> }).content
    expect(content[0].text).toContain('New session started')

    expect(wc.send).toHaveBeenCalledWith('agent-session:spawn', {
      sourceTerminalId: 'spawn-test-term',
      brief: 'rebase and land PR #42',
      label: 'rebase',
      target: 'new-pane',
    })
  }, 15000)
})
