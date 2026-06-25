import { type ChildProcess, spawn } from 'child_process'
import { execSync, type ExecSyncOptions } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'
import type { WebContents } from 'electron'
import type { JsonRpcMessage } from '../shared/ipc-types'

// ── Binary resolution ──────────────────────────────────────

export interface ResolveOpts {
  existsSync?: (path: string) => boolean
  execSync?: (cmd: string, opts?: ExecSyncOptions) => Buffer | string
}

/**
 * Look for a binary in the project's node_modules/.bin.
 * Returns the full path if found, null otherwise.
 */
export function findBinaryInProject(
  name: string,
  rootDir: string,
  opts: ResolveOpts = {}
): string | null {
  const check = opts.existsSync ?? existsSync
  const candidate = join(rootDir, 'node_modules', '.bin', name)
  return check(candidate) ? candidate : null
}

/**
 * Look for a binary on the system PATH using `which`.
 * Returns the binary name (to be passed to spawn) if found, null otherwise.
 */
export function findBinaryInPath(name: string, opts: ResolveOpts = {}): string | null {
  const exec = opts.execSync ?? execSync
  try {
    const result = exec(`which ${name}`, { encoding: 'utf8' })
    const path = result.toString().trim()
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

/**
 * Resolve a binary: project node_modules/.bin first, then PATH.
 * Returns null if unavailable in either location.
 */
export function resolveBinary(
  name: string,
  rootDir: string,
  opts: ResolveOpts = {}
): string | null {
  return findBinaryInProject(name, rootDir, opts) ?? findBinaryInPath(name, opts)
}

/**
 * Find the workspace TypeScript installation's tsserver.js.
 * Returns the full path if found, null if the project doesn't have TypeScript.
 */
export function resolveTsServerPath(rootDir: string, opts: ResolveOpts = {}): string | null {
  const check = opts.existsSync ?? existsSync
  const candidate = join(rootDir, 'node_modules', 'typescript', 'lib', 'tsserver.js')
  return check(candidate) ? candidate : null
}

// ── Server command builders ────────────────────────────────

const LANGUAGE_BINARY: Record<string, string> = {
  typescript: 'typescript-language-server',
  javascript: 'typescript-language-server',
  rust: 'rust-analyzer',
  python: 'pylsp',
  go: 'gopls',
  css: 'vscode-css-language-server',
  scss: 'vscode-css-language-server',
  less: 'vscode-css-language-server',
  json: 'vscode-json-language-server',
}

/**
 * Build the argv for spawning the language server.
 * Exported for testing.
 *
 * Note: TypeScript's tsserver path is NOT passed as a CLI flag — it is sent
 * via LSP initializationOptions in the initialize request instead.
 */
export function buildServerArgv(
  _language: string,
  binary: string
): string[] {
  return [binary, '--stdio']
}

/**
 * Build language-specific initializationOptions to include in the LSP
 * initialize request. Returns undefined when there is nothing to configure.
 */
export function buildInitializationOptions(
  language: string,
  rootDir: string,
  opts: ResolveOpts = {}
): Record<string, unknown> | undefined {
  if (language === 'typescript' || language === 'javascript') {
    const tsServerPath = resolveTsServerPath(rootDir, opts)
    if (tsServerPath) {
      return { tsserver: { path: tsServerPath } }
    }
  }
  return undefined
}

// ── Server lifecycle ───────────────────────────────────────

interface LspServer {
  serverId: string
  process: ChildProcess
  reader: StreamMessageReader
  writer: StreamMessageWriter
  subscribers: Set<WebContents>
}

const servers = new Map<string, LspServer>()

function makeServerId(language: string, rootUri: string): string {
  return `${language}:${rootUri}`
}

export interface StartServerResult {
  serverId: string
  initializationOptions: Record<string, unknown> | undefined
}

/**
 * Start a language server for the given language + rootUri, or return
 * the existing server's id if one is already running.
 * Registers `sender` as a subscriber for messages from this server.
 */
export function startServer(
  language: string,
  rootUri: string,
  sender: WebContents
): StartServerResult {
  const serverId = makeServerId(language, rootUri)

  const existing = servers.get(serverId)
  if (existing) {
    existing.subscribers.add(sender)
    return {
      serverId,
      initializationOptions: buildInitializationOptions(language, rootUri),
    }
  }

  const binaryName = LANGUAGE_BINARY[language]
  if (!binaryName) {
    throw new Error(`No language server configured for language: ${language}`)
  }

  const binary = resolveBinary(binaryName, rootUri)
  if (!binary) {
    throw new Error(
      `Language server '${binaryName}' not found. ` +
      `Install it in ${rootUri}/node_modules or on your PATH.`
    )
  }

  const argv = buildServerArgv(language, binary)
  const [cmd, ...args] = argv
  const proc = spawn(cmd, args, {
    cwd: rootUri,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const reader = new StreamMessageReader(proc.stdout!)
  const writer = new StreamMessageWriter(proc.stdin!)

  const server: LspServer = {
    serverId,
    process: proc,
    reader,
    writer,
    subscribers: new Set([sender]),
  }
  servers.set(serverId, server)

  reader.listen((message) => {
    const data = message as JsonRpcMessage
    for (const wc of server.subscribers) {
      if (!wc.isDestroyed()) {
        wc.send('lsp:message', { serverId, message: data })
      }
    }
  })

  proc.on('exit', (code) => {
    servers.delete(serverId)
    for (const wc of server.subscribers) {
      if (!wc.isDestroyed()) {
        wc.send('lsp:server-exit', { serverId, code })
      }
    }
  })

  proc.stderr?.on('data', (data: Buffer) => {
    console.error(`[LSP ${serverId}]`, data.toString())
  })

  return {
    serverId,
    initializationOptions: buildInitializationOptions(language, rootUri),
  }
}

/**
 * Forward a JSON-RPC message from the renderer to the language server.
 */
export function sendToServer(serverId: string, message: JsonRpcMessage): void {
  const server = servers.get(serverId)
  if (!server) return
  server.writer.write(message as Parameters<StreamMessageWriter['write']>[0])
}

/**
 * Gracefully stop a language server and remove it from the registry.
 */
export function stopServer(serverId: string): void {
  const server = servers.get(serverId)
  if (!server) return
  servers.delete(serverId)
  server.reader.dispose()
  server.writer.dispose()
  server.process.kill()
}

/**
 * Stop all running language servers. Called on app quit.
 */
export function stopAllServers(): void {
  for (const serverId of servers.keys()) {
    stopServer(serverId)
  }
}
