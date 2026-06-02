import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'child_process'
import { spawn } from 'child_process'
import { join } from 'path'
import { startBridge, stopBridge, getBridgeInfo, stopAllBridges } from '../mcp-bridge'
import { attachToTerminal, detachFromTerminal } from '../claude-stream'

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

  it('POST to /token/tool-call with show_plan emits correct IPC event', async () => {
    const plan = {
      overview: 'Test plan overview',
      tasks: [
        {
          id: 't1',
          title: 'Task one',
          description: 'Do the thing',
          status: 'todo',
          reactions: [],
          discussion: [],
        },
      ],
    }

    const res = await post(`/${token}/tool-call`, {
      tool: 'show_plan',
      terminalId: 'term-123',
      args: { plan, worktreePath: '/test/repo' },
    })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(wc.send).toHaveBeenCalledWith('plan:from-claude', {
      key: '/test/repo:claude-term-123',
      terminalId: 'term-123',
      plan,
    })
  })

  it('returns 404 for wrong token path', async () => {
    const res = await post('/wrong-token/tool-call', {
      tool: 'show_plan',
      terminalId: 'term-1',
      args: { plan: { overview: '', tasks: [] }, worktreePath: '/test' },
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
      tool: 'show_plan',
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

  it('returns 400 for show_plan missing required args', async () => {
    const res = await post(`/${token}/tool-call`, {
      tool: 'show_plan',
      terminalId: 'term-1',
      args: { plan: { overview: '', tasks: [] } },
      // missing worktreePath
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/${token}/tool-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('does not emit IPC when webContents is destroyed', async () => {
    wc.isDestroyed.mockReturnValue(true)

    const res = await post(`/${token}/tool-call`, {
      tool: 'show_plan',
      terminalId: 'term-1',
      args: {
        plan: { overview: '', tasks: [] },
        worktreePath: '/test',
      },
    })

    expect(res.status).toBe(200)
    expect(wc.send).not.toHaveBeenCalled()
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

  it('MCP server show_plan call flows through to bridge IPC', async () => {
    // Spawn the real MCP server with bridge env vars
    mcpProc = spawn('node', [MCP_SERVER_PATH], {
      env: {
        ...process.env,
        SIMPLEEDIT_BRIDGE_PORT: String(port),
        SIMPLEEDIT_BRIDGE_TOKEN: token,
        SIMPLEEDIT_TERMINAL_ID: 'mcp-test-term',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Step 1: Initialize the MCP session
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

    // Step 2: Send initialized notification
    mcpProc.stdin!.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n')

    await new Promise((resolve) => setTimeout(resolve, 200))

    // Step 3: Call the show_plan tool
    const toolResponse = await sendMcpMessage(mcpProc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'show_plan',
        arguments: {
          plan: {
            overview: 'Integration test plan',
            tasks: [
              {
                title: 'Integration task',
                description: 'Verify the full chain',
              },
            ],
          },
          worktreePath: '/integration/test',
        },
      },
    })

    expect(toolResponse['id']).toBe(2)
    const result = toolResponse['result'] as Record<string, unknown>
    expect(result).toBeDefined()
    const content = result['content'] as Array<{ type: string; text: string }>
    expect(content[0].text).toContain('Plan displayed')

    // Verify the bridge forwarded to webContents
    // Zod applies defaults (status: 'todo') and strips unknown fields
    expect(wc.send).toHaveBeenCalledWith('plan:from-claude', {
      key: '/integration/test:claude-mcp-test-term',
      terminalId: 'mcp-test-term',
      plan: {
        overview: 'Integration test plan',
        tasks: [
          {
            title: 'Integration task',
            description: 'Verify the full chain',
            status: 'todo',
          },
        ],
      },
    })
  }, 15000)

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
})
