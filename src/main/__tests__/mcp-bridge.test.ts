import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'child_process'
import { spawn } from 'child_process'
import { join } from 'path'
import { startBridge, stopBridge, getBridgeInfo, stopAllBridges } from '../mcp-bridge'

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
})

// This test requires the built MCP server artifact (out/mcp-server/index.mjs).
// Skip in CI where it may not be available during the unit test phase.
const skipIntegration = !!process.env.CI

describe.skipIf(skipIntegration)('MCP Server → Bridge integration', () => {
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
})
