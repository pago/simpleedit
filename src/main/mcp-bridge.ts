import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { WebContents } from 'electron'
import type { Plan } from '../shared/ipc-types'
import { savePlan } from './plan'

interface BridgeInstance {
  server: Server
  port: number
  token: string
  webContents: WebContents
}

const bridges = new Map<number, BridgeInstance>()

interface ToolCallPayload {
  tool: string
  args: Record<string, unknown>
  terminalId: string
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function jsonResponse(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// -- Latest Claude plan pointer persistence --------------------

function latestClaudePlanFile(): string {
  const dir = join(app.getPath('userData'), 'config', 'plans')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'latest-claude-plans.json')
}

function saveLatestClaudePlan(worktreePath: string, terminalId: string): void {
  try {
    let existing: Record<string, string> = {}
    try {
      existing = JSON.parse(readFileSync(latestClaudePlanFile(), 'utf-8')) as Record<string, string>
    } catch { /* file doesn't exist yet */ }
    existing[worktreePath] = terminalId
    writeFileSync(latestClaudePlanFile(), JSON.stringify(existing, null, 2), 'utf-8')
  } catch (err) {
    console.error('[MCP Bridge] Failed to save latest Claude plan pointer:', err)
  }
}

export function loadLatestClaudePlan(worktreePath: string): string | null {
  try {
    const data = JSON.parse(readFileSync(latestClaudePlanFile(), 'utf-8')) as Record<string, string>
    return data[worktreePath] ?? null
  } catch {
    return null
  }
}

// -- Tool call handling ----------------------------------------

function handleToolCall(payload: ToolCallPayload, webContents: WebContents): { status: number; body: Record<string, unknown> } {
  const { tool, args, terminalId } = payload

  if (tool === 'show_plan') {
    const plan = args['plan'] as Plan | undefined
    const worktreePath = args['worktreePath'] as string | undefined

    if (!plan || !worktreePath) {
      return { status: 400, body: { error: 'show_plan requires plan and worktreePath in args' } }
    }

    // Persist the plan to disk so it survives app restarts
    savePlan(worktreePath, `claude-${terminalId}`, plan)
    saveLatestClaudePlan(worktreePath, terminalId)

    const key = `${worktreePath}:claude-${terminalId}`
    if (!webContents.isDestroyed()) {
      webContents.send('plan:from-claude', { key, terminalId, plan })
    }

    return { status: 200, body: { ok: true } }
  }

  return { status: 400, body: { error: `Unknown tool: ${tool}` } }
}

function createBridgeServer(token: string, webContents: WebContents): Server {
  return createServer(async (req, res) => {
    // Validate token from URL path: /<token>/tool-call
    const expectedPath = `/${token}/tool-call`

    if (req.method === 'POST' && req.url === expectedPath) {
      try {
        const body = await readBody(req)
        const payload = JSON.parse(body) as ToolCallPayload

        if (!payload.tool || typeof payload.tool !== 'string') {
          jsonResponse(res, 400, { error: 'Missing or invalid "tool" field' })
          return
        }
        if (!payload.terminalId || typeof payload.terminalId !== 'string') {
          jsonResponse(res, 400, { error: 'Missing or invalid "terminalId" field' })
          return
        }

        const result = handleToolCall(payload, webContents)
        jsonResponse(res, result.status, result.body)
      } catch {
        jsonResponse(res, 400, { error: 'Invalid JSON body' })
      }
      return
    }

    jsonResponse(res, 404, { error: 'Not found' })
  })
}

export function startBridge(webContentsId: number, webContents: WebContents): Promise<number> {
  const existing = bridges.get(webContentsId)
  if (existing) {
    return Promise.resolve(existing.port)
  }

  const token = randomBytes(16).toString('hex')
  const server = createBridgeServer(token, webContents)

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Failed to get server address'))
        return
      }

      const port = addr.port
      bridges.set(webContentsId, { server, port, token, webContents })
      console.log(`[MCP Bridge] Started for webContents ${webContentsId} on 127.0.0.1:${port}`)
      resolve(port)
    })

    server.on('error', (err) => {
      reject(err)
    })
  })
}

export function stopBridge(webContentsId: number): void {
  const bridge = bridges.get(webContentsId)
  if (bridge) {
    bridge.server.close()
    bridges.delete(webContentsId)
    console.log(`[MCP Bridge] Stopped for webContents ${webContentsId}`)
  }
}

export function stopAllBridges(): void {
  for (const [id, bridge] of bridges) {
    bridge.server.close()
    bridges.delete(id)
  }
}

export function getBridgeInfo(webContentsId: number): { port: number; token: string } | null {
  const bridge = bridges.get(webContentsId)
  if (!bridge) return null
  return { port: bridge.port, token: bridge.token }
}
