/**
 * The Claude memory view's main side: locate a session's auto-memory dir,
 * decide whether it is git-tracked, and walk it for the file list and health.
 *
 * `memory:*` is reachable from the phone socket, and `autoMemoryDirectory` can
 * name any directory, so the walk/health/watch channels only accept dirs that
 * `resolveMemoryLocation` handed out, and resolve refuses dirs that would
 * expose a whole home or config tree.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, relative, sep } from 'path'
import simpleGit from 'simple-git'
import type { MemoryGit, MemoryLocation } from '../shared/ipc-types'
import {
  analyzeMemory,
  findMemoryIndex,
  MEMORY_MAX_DEPTH,
  MEMORY_MAX_FILE_BYTES,
  MEMORY_MAX_FILES,
  type MemoryFile,
  type MemoryHealthReport,
} from '../shared/memory-health'
import { claudeConfigDir, claudeMemoryDir, type ClaudeEnv } from './claude-paths'
import { claudeShellEnv } from './shell-path'

const handedOut = new Set<string>()

function realpathOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isAncestorOrSelf(ancestor: string, p: string): boolean {
  const rel = relative(ancestor, p)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** `/`, `$HOME`, the config dir itself, or anything containing `$HOME`. */
export function isRefusedMemoryDir(dir: string, env: ClaudeEnv): boolean {
  const real = realpathOr(dir)
  const home = realpathOr(homedir())
  const config = realpathOr(claudeConfigDir(env))
  return real === '/' || real === config || isAncestorOrSelf(real, home)
}

async function detectGit(memoryDir: string): Promise<MemoryGit | null> {
  const git = simpleGit(memoryDir)
  try {
    const toplevel = (await git.revparse(['--show-toplevel'])).trim()
    const root = realpathOr(toplevel)
    const rel = relative(root, realpathOr(memoryDir)).split(sep).join('/')
    const pathspec = rel === '' ? null : rel
    if (pathspec !== null && (await git.checkIgnore([memoryDir])).length > 0) return null
    // An unborn HEAD makes `git log` reject, so a repo without commits is no-git.
    await git.revparse(['--verify', 'HEAD'])
    return { root, pathspec }
  } catch {
    return null
  }
}

/**
 * Locate the memory dir for a session launched in `launchDir`. `env` defaults
 * to the environment the CLI sees; tests pass their own.
 */
export async function resolveMemoryLocation(launchDir: string, env?: ClaudeEnv): Promise<MemoryLocation> {
  const claudeEnv = env ?? (await claudeShellEnv())
  const memoryDir = await claudeMemoryDir(launchDir, claudeEnv)
  if (isRefusedMemoryDir(memoryDir, claudeEnv)) {
    return { memoryDir, exists: false, git: null }
  }
  handedOut.add(memoryDir)
  const exists = isDirectory(memoryDir)
  return { memoryDir, exists, git: exists ? await detectGit(memoryDir) : null }
}

function assertHandedOut(memoryDir: string): void {
  if (!handedOut.has(memoryDir)) throw new Error(`Not a resolved memory dir: ${memoryDir}`)
}

export function isHandedOutMemoryDir(memoryDir: string): boolean {
  return handedOut.has(memoryDir)
}

/** Files under `memoryDir` (relative, `/`-separated), bounded and skipping `.git`. */
function walk(memoryDir: string): string[] {
  const out: string[] = []
  const visit = (dir: string, prefix: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (out.length >= MEMORY_MAX_FILES) return
      if (entry.name === '.git') continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // Same reach as the watcher's chokidar `depth`: that many subdir levels.
        if (depth < MEMORY_MAX_DEPTH) visit(join(dir, entry.name), rel, depth + 1)
      } else if (entry.isFile()) {
        out.push(rel)
      }
    }
  }
  visit(memoryDir, '', 0)
  return out
}

export function listMemoryFiles(memoryDir: string): string[] {
  assertHandedOut(memoryDir)
  return walk(memoryDir)
}

function readMemoryFile(abs: string, rel: string): string {
  if (!/\.md$/i.test(rel)) return ''
  try {
    if (statSync(abs).size > MEMORY_MAX_FILE_BYTES) return ''
    return readFileSync(abs, 'utf8')
  } catch {
    return ''
  }
}

export function memoryHealth(memoryDir: string): MemoryHealthReport {
  assertHandedOut(memoryDir)
  const files: MemoryFile[] = walk(memoryDir).map((rel) => ({
    rel,
    content: readMemoryFile(join(memoryDir, rel), rel),
  }))
  return {
    memoryDir,
    indexPresent: findMemoryIndex(files) !== undefined,
    fileCount: files.length,
    issues: analyzeMemory(files).map((issue) => ({ ...issue, file: join(memoryDir, ...issue.rel.split('/')) })),
  }
}

/** Test seam: forget every handed-out dir. */
export function _resetHandedOutForTests(): void {
  handedOut.clear()
}
