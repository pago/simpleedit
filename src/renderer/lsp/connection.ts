import type { JsonRpcMessage } from '../../shared/ipc-types'

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: unknown) => void
}

type NotificationHandler = (params: unknown) => void

/**
 * Minimal JSON-RPC 2.0 connection over Electron IPC.
 *
 * The main process proxies messages between this connection and the language
 * server process. No Content-Length framing is needed here — IPC handles the
 * transport.
 */
export class LspConnection {
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private notificationHandlers = new Map<string, Set<NotificationHandler>>()
  private removeListener: () => void
  private disposed = false

  constructor(readonly serverId: string) {
    this.removeListener = window.api.on('lsp:message', ({ serverId, message }) => {
      if (serverId !== this.serverId) return
      this.handleMessage(message)
    })
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response: has 'id' and either 'result' or 'error', but no 'method'
    if ('id' in msg && !('method' in msg)) {
      const id = msg['id'] as number
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      if ('error' in msg) {
        pending.reject(msg['error'])
      } else {
        pending.resolve(msg['result'])
      }
      return
    }

    // Notification: has 'method' but no 'id'
    if ('method' in msg && !('id' in msg)) {
      const method = msg['method'] as string
      const handlers = this.notificationHandlers.get(method)
      if (handlers) {
        for (const handler of handlers) {
          handler(msg['params'])
        }
      }
      return
    }

    // Server-initiated requests (e.g. window/showMessage) — not handled yet
    if ('method' in msg && 'id' in msg) {
      // Send a "method not found" error back
      this.sendRaw({
        jsonrpc: '2.0',
        id: msg['id'],
        error: { code: -32601, message: 'Method not found' },
      })
    }
  }

  sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Connection disposed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject })
      this.sendRaw({ jsonrpc: '2.0', id, method, params })
    })
  }

  sendNotification(method: string, params?: unknown): void {
    if (this.disposed) return
    this.sendRaw({ jsonrpc: '2.0', method, params })
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    if (!this.notificationHandlers.has(method)) {
      this.notificationHandlers.set(method, new Set())
    }
    this.notificationHandlers.get(method)!.add(handler)
    return () => this.notificationHandlers.get(method)?.delete(handler)
  }

  private sendRaw(message: JsonRpcMessage): void {
    window.api.send('lsp:send', { serverId: this.serverId, message })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeListener()
    for (const { reject } of this.pending.values()) {
      reject(new Error('Connection disposed'))
    }
    this.pending.clear()
    this.notificationHandlers.clear()
  }
}
