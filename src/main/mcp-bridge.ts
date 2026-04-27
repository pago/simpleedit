import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { WebContents } from 'electron'
import type { Plan, Tour } from '../shared/ipc-types'
import { savePlan } from './plan'
import { saveTour, tourKey } from './tour'
import { getWorktreeForTerminal } from './claude-stream'
import { validateSpec, validateSpecActions } from './gen-ui-validate'

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

async function handleToolCall(payload: ToolCallPayload, webContents: WebContents): Promise<{ status: number; body: Record<string, unknown> }> {
  const { tool, args, terminalId } = payload

  if (tool === 'show_plan') {
    const plan = args['plan'] as Plan | undefined
    const claudeWorktreePath = args['worktreePath'] as string | undefined

    if (!plan) {
      return { status: 400, body: { error: 'show_plan requires plan in args' } }
    }

    // Use the authoritative worktree path from the terminal attachment,
    // falling back to what Claude provided. The terminal-to-worktree mapping
    // is set when the terminal is spawned and always matches the WorktreePane's path.
    const worktreePath = getWorktreeForTerminal(terminalId) ?? claudeWorktreePath
    if (!worktreePath) {
      return { status: 400, body: { error: 'Could not determine worktree path for this terminal' } }
    }

    // Persist the plan to disk so it survives app restarts
    savePlan(worktreePath, `claude-${terminalId}`, plan)
    saveLatestClaudePlan(worktreePath, terminalId)

    const key = `${worktreePath}:claude-${terminalId}`
    if (!webContents.isDestroyed()) {
      webContents.send('plan:from-claude', { key, terminalId, plan })
    } else {
      console.warn(`[MCP Bridge] webContents is destroyed, cannot send plan:from-claude IPC`)
    }

    return { status: 200, body: { ok: true } }
  }

  if (tool === 'complete_task') {
    const tour = args['tour'] as Tour | undefined
    const claudeWorktreePath = args['worktreePath'] as string | undefined
    const commitHashArg = args['commitHash']
    const openQuestions = args['openQuestions'] as string[] | undefined

    if (!tour) {
      return { status: 400, body: { error: 'complete_task requires tour in args' } }
    }

    const worktreePath = getWorktreeForTerminal(terminalId) ?? claudeWorktreePath
    if (!worktreePath) {
      return { status: 400, body: { error: 'Could not determine worktree path for this terminal' } }
    }

    const commitHash: string | null = typeof commitHashArg === 'string' && commitHashArg ? commitHashArg : null

    // Assign stable topic ids so Svelte's keyed iteration and segment toggle state work correctly —
    // the MCP schema doesn't carry ids because they're not meaningful to the agent.
    const keyPrefix = tourKey(worktreePath, commitHash)
    const topicsWithIds = tour.topics.map((t, i) => ({ ...t, id: `${keyPrefix}:topic-${i}` }))

    const persistedTour: Tour = { ...tour, topics: topicsWithIds }
    if (openQuestions && openQuestions.length > 0) {
      persistedTour.openQuestions = openQuestions
    } else {
      delete persistedTour.openQuestions
    }

    saveTour(worktreePath, commitHash, persistedTour)

    const key = tourKey(worktreePath, commitHash)
    if (!webContents.isDestroyed()) {
      webContents.send('tour:from-claude', {
        key,
        terminalId,
        worktreePath,
        commitHash,
        tour: persistedTour,
      })
    } else {
      console.warn(`[MCP Bridge] webContents is destroyed, cannot send tour:from-claude IPC`)
    }

    return { status: 200, body: { ok: true } }
  }

  if (tool === 'show_panel') {
    const claudeWorktreePath = args['worktreePath'] as string | undefined
    const title = typeof args['title'] === 'string' ? (args['title'] as string) : 'Agent panel'

    const worktreePath = getWorktreeForTerminal(terminalId) ?? claudeWorktreePath
    if (!worktreePath) {
      return { status: 400, body: { error: 'Could not determine worktree path for this terminal' } }
    }

    const validation = validateSpec(args['spec'])
    if (!validation.ok) {
      return {
        status: 400,
        body: {
          error: 'spec validation failed',
          issues: validation.issues,
        },
      }
    }

    const actionIssues = await validateSpecActions(validation.spec, worktreePath)
    if (actionIssues.length > 0) {
      return {
        status: 400,
        body: {
          error: 'spec actions reference content outside the active worktree',
          issues: actionIssues,
        },
      }
    }

    if (!webContents.isDestroyed()) {
      webContents.send('agent-panel:open', {
        spec: validation.spec,
        title,
        worktreePath,
        sourceTerminalId: terminalId,
      })
    } else {
      console.warn(`[MCP Bridge] webContents is destroyed, cannot send agent-panel:open IPC`)
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

        const result = await handleToolCall(payload, webContents)
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
