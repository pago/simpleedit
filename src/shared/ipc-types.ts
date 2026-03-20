/**
 * All IPC channel definitions. Each feature uses a namespaced prefix.
 * Renderer → Main: invoke channels (request/response)
 * Main → Renderer: event channels (push)
 */

// ── Worktree ──────────────────────────────────────────────
export interface WorktreeInfo {
  path: string
  branch: string
  isMain: boolean
  isCurrent: boolean
}

export interface WorktreeInvokeMap {
  'worktree:list': { args: []; result: WorktreeInfo[] }
  'worktree:create': { args: [name: string, baseBranch?: string]; result: WorktreeInfo }
  'worktree:remove': { args: [path: string]; result: void }
}

export interface WorktreeEventMap {
  'worktree:changed': WorktreeInfo[]
}

// ── PTY / Terminal ────────────────────────────────────────
export interface PtySpawnOptions {
  worktreePath: string
  id: string
}

export interface PtyInvokeMap {
  'pty:spawn': { args: [options: PtySpawnOptions]; result: void }
  'pty:write': { args: [id: string, data: string]; result: void }
  'pty:resize': { args: [id: string, cols: number, rows: number]; result: void }
  'pty:kill': { args: [id: string]; result: void }
}

export interface PtyEventMap {
  'pty:data': { id: string; data: string }
  'pty:exit': { id: string; exitCode: number }
}

// ── File system ───────────────────────────────────────────
export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  children?: FileEntry[]
}

export interface FsInvokeMap {
  'fs:list': { args: [dirPath: string]; result: FileEntry[] }
  'fs:read': { args: [filePath: string]; result: string }
  'fs:write': { args: [filePath: string, content: string]; result: void }
  'fs:watch': { args: [worktreePath: string]; result: void }
  'fs:unwatch': { args: []; result: void }
}

export interface FsEventMap {
  'fs:changed': { path: string; event: 'add' | 'change' | 'unlink' }
}

// ── Editor ────────────────────────────────────────────────
export interface EditorInvokeMap {
  'editor:open': { args: [filePath: string]; result: string }
  'editor:save': { args: [filePath: string, content: string]; result: void }
}

// ── Git ───────────────────────────────────────────────────
export interface GitCommitInfo {
  hash: string
  message: string
  author: string
  date: string
}

export interface GitInvokeMap {
  'git:log': { args: [worktreePath: string, count?: number]; result: GitCommitInfo[] }
  'git:diff': { args: [worktreePath: string, commitHash: string]; result: string }
}

// ── Claude stream ─────────────────────────────────────────
export type ClaudeStatus = 'idle' | 'running' | 'waiting' | 'error'

export interface ClaudeInvokeMap {
  'claude:spawn': { args: [options: PtySpawnOptions]; result: void }
  'claude:attach': { args: [terminalId: string, worktreePath: string]; result: void }
  'claude:detach': { args: [terminalId: string]; result: void }
}

export interface ClaudeEventMap {
  'claude:status': { worktreePath: string; status: ClaudeStatus }
  'claude:file-touch': { worktreePath: string; filePath: string }
}

// ── Aggregate maps for type-safe IPC helpers ──────────────
export type InvokeMap = WorktreeInvokeMap &
  PtyInvokeMap &
  FsInvokeMap &
  EditorInvokeMap &
  GitInvokeMap &
  ClaudeInvokeMap

export type EventMap = WorktreeEventMap &
  PtyEventMap &
  FsEventMap &
  ClaudeEventMap
