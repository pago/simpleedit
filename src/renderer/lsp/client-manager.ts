import type { InitializeResult, ServerCapabilities } from 'vscode-languageserver-protocol'
import { LspConnection } from './connection'
import { registerProviders } from './providers'
import { LSP_SUPPORTED_LANGUAGES, CLIENT_CAPABILITIES } from './language-map'

// ── Path ↔ URI ────────────────────────────────────────────

export function pathToUri(filePath: string): string {
  // Handles both /absolute/unix and C:\windows paths
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

// ── Active client state ───────────────────────────────────

interface LspClient {
  connection: LspConnection
  capabilities: ServerCapabilities
  disposeProviders: () => void
  /** monotonically increasing doc version per URI */
  docVersions: Map<string, number>
}

/**
 * Tracks language server connections and Monaco provider registrations.
 *
 * Lifecycle:
 *  1. ensureClient() → starts (or reuses) a server, does the LSP handshake,
 *     registers Monaco providers
 *  2. openDocument() → textDocument/didOpen
 *  3. changeDocument() → textDocument/didChange (full sync)
 *  4. closeDocument() → textDocument/didClose
 */
export class LspClientManager {
  /** serverId → LspClient */
  private clients = new Map<string, LspClient>()
  /** serverId → in-flight initialization promise */
  private initializing = new Map<string, Promise<LspClient>>()
  /** languageId → whether Monaco providers are registered for it */
  private registeredLanguages = new Set<string>()

  async ensureClient(languageId: string, rootUri: string): Promise<LspClient | null> {
    if (!LSP_SUPPORTED_LANGUAGES.has(languageId)) return null

    const serverId = `${languageId}:${rootUri}`

    const existing = this.clients.get(serverId)
    if (existing) return existing

    const inFlight = this.initializing.get(serverId)
    if (inFlight) return inFlight

    const promise = this.initClient(languageId, rootUri, serverId)
    this.initializing.set(serverId, promise)
    promise.then(
      (client) => {
        this.clients.set(serverId, client)
        this.initializing.delete(serverId)
      },
      () => this.initializing.delete(serverId)
    )
    return promise
  }

  private async initClient(
    languageId: string,
    rootUri: string,
    serverId: string
  ): Promise<LspClient> {
    const rootFileUri = pathToUri(rootUri)

    // Ask main process to spawn (or retrieve) the language server
    const startResult = await window.api.invoke('lsp:start', { language: languageId, rootUri })
    if (startResult.serverId === null) {
      throw new Error(startResult.reason)
    }
    const { serverId: actualServerId, initializationOptions } = startResult

    const connection = new LspConnection(actualServerId)

    // LSP initialize handshake
    let initResult: InitializeResult
    try {
      initResult = await connection.sendRequest<InitializeResult>('initialize', {
        processId: null,
        rootUri: rootFileUri,
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: initializationOptions ?? {},
      })
    } catch (err) {
      connection.dispose()
      throw err
    }

    connection.sendNotification('initialized', {})

    const capabilities = initResult.capabilities

    // Register Monaco providers once per language (they are global to Monaco)
    let disposeProviders = (): void => { /* no-op if already registered */ }
    if (!this.registeredLanguages.has(languageId)) {
      this.registeredLanguages.add(languageId)
      disposeProviders = registerProviders(languageId, connection, capabilities)
    }

    // Clean up if server exits unexpectedly
    window.api.on('lsp:server-exit', ({ serverId: exitedId }) => {
      if (exitedId !== actualServerId) return
      console.warn(`[LSP] Server exited: ${exitedId}`)
      this.clients.delete(serverId)
      connection.dispose()
    })

    return { connection, capabilities, disposeProviders, docVersions: new Map() }
  }

  async openDocument(
    filePath: string,
    languageId: string,
    text: string,
    rootUri: string
  ): Promise<void> {
    const client = await this.ensureClient(languageId, rootUri)
    if (!client) return

    const uri = pathToUri(filePath)
    const version = 1
    client.docVersions.set(uri, version)

    client.connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    })
  }

  changeDocument(filePath: string, languageId: string, text: string, rootUri: string): void {
    const serverId = `${languageId}:${rootUri}`
    const client = this.clients.get(serverId)
    if (!client) return

    const uri = pathToUri(filePath)
    const version = (client.docVersions.get(uri) ?? 0) + 1
    client.docVersions.set(uri, version)

    client.connection.sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }], // full sync
    })
  }

  closeDocument(filePath: string, languageId: string, rootUri: string): void {
    const serverId = `${languageId}:${rootUri}`
    const client = this.clients.get(serverId)
    if (!client) return

    const uri = pathToUri(filePath)
    client.docVersions.delete(uri)

    client.connection.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    })
  }
}

export const lspClientManager = new LspClientManager()
