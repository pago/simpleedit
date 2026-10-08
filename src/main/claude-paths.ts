/**
 * Filesystem-layout helpers for Claude Code's per-project storage.
 *
 * The CLI stores per-cwd state under `<configDir>/projects/<encoded-cwd>/`,
 * where `<encoded-cwd>` is the realpath of the worktree (so /tmp → /private/tmp
 * on macOS) with every non-alphanumeric character replaced by a single `-`.
 * See https://github.com/anthropics/claude-code (no public spec; encoding
 * verified empirically against CLI 2.1.148).
 *
 * The encoding is lossy by design: `/foo bar`, `/foo-bar`, `/foo_bar`,
 * `/foo.bar`, and `/foo:bar` all collapse to the same project-dir name.
 * In practice SimpleEdit worktree paths don't collide (e.g.
 * `~/Projects/.../my-branch` and `~/Projects/.../my_branch` would, but that
 * pattern doesn't appear naturally). Callers that need to be sure should
 * pre-validate inputs.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import simpleGit from 'simple-git'

/** The slice of the environment the Claude CLI's storage layout depends on. */
export interface ClaudeEnv {
  CLAUDE_CONFIG_DIR?: string
  CLAUDE_CODE_PROJECT_DIR_NAME?: string
}

/** Project keys longer than this are truncated and suffixed with a hash (CLI 2.1.294). */
export const PROJECT_KEY_MAX = 200

/**
 * The CLI's key hash: Java's `String.hashCode` over UTF-16 code units,
 * rendered as `Math.abs(h).toString(36)`. Extracted from CLI 2.1.294.
 */
export function claudeKeyHash(value: string): string {
  let h = 0
  for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

/** Encode an already-resolved path into a project key, applying the length cap. */
export function encodeProjectKey(resolvedPath: string): string {
  const key = resolvedPath.replace(/[^A-Za-z0-9]/g, '-')
  if (key.length <= PROJECT_KEY_MAX) return key
  return `${key.slice(0, PROJECT_KEY_MAX)}-${claudeKeyHash(resolvedPath)}`
}

/**
 * Encode an absolute path the same way the Claude CLI does to derive its
 * `projects/<...>/` directory name. Resolves symlinks first.
 */
export function claudeProjectDirName(absPath: string): string {
  return encodeProjectKey(realpathSync(absPath))
}

/** `CLAUDE_CONFIG_DIR ?? ~/.claude`. */
export function claudeConfigDir(env: ClaudeEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR
  return dir ? dir : join(homedir(), '.claude')
}

/** Absolute path of the projects directory the Claude CLI uses for `cwd`. */
export function claudeProjectsDir(cwd: string, env: ClaudeEnv = process.env): string {
  return join(claudeConfigDir(env), 'projects', claudeProjectDirName(cwd))
}

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

/**
 * `autoMemoryDirectory` from the user settings file only. The CLI ignores it in
 * checked-in project settings, and local/project scopes sit behind a trust gate
 * we can't reproduce — reading them would let a cloned repo aim the editor,
 * watcher and git at any directory.
 */
export function userAutoMemoryDirectory(env: ClaudeEnv = process.env): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(claudeConfigDir(env), 'settings.json'), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const value = (parsed as Record<string, unknown>)['autoMemoryDirectory']
  if (typeof value !== 'string' || value.trim() === '') return null
  const trimmed = value.trim()
  if (trimmed === '~' || trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(1))
  return isAbsolute(trimmed) ? trimmed : null
}

/**
 * The project roots Claude Code may have keyed `launchDir`'s memory under, most
 * likely first: the main worktree root, the work tree's own toplevel, then
 * `launchDir` itself. The docs say memory is "derived from the git repository"
 * without pinning which root, so callers probe all of them.
 */
async function projectRootCandidates(launchDir: string): Promise<string[]> {
  const out: string[] = []
  const add = (p: string): void => {
    const real = realpathOr(p)
    if (!out.includes(real)) out.push(real)
  }
  if (isDirectory(launchDir)) {
    try {
      const git = simpleGit(launchDir)
      const inside = (await git.revparse(['--is-inside-work-tree'])).trim()
      if (inside === 'true') {
        const common = realpathOr(resolve(launchDir, (await git.revparse(['--git-common-dir'])).trim()))
        if (basename(common) === '.git') add(dirname(common))
        add((await git.revparse(['--show-toplevel'])).trim())
      }
    } catch {
      // Not a git work tree (or git unavailable): only launchDir is a candidate.
    }
  }
  add(launchDir)
  return out
}

/**
 * For an over-cap key, the projects/ entry the CLI made for it. Tries the
 * ported hash first, then falls back to a unique entry with the truncated
 * prefix — so a hash mismatch in some future CLI degrades gracefully.
 */
function resolveOverCapKey(projectsRoot: string, key: string): string | null {
  if (key.length <= PROJECT_KEY_MAX) return null
  if (isDirectory(join(projectsRoot, key, 'memory'))) return key
  const prefix = `${key.slice(0, PROJECT_KEY_MAX)}-`
  let entries: string[]
  try {
    entries = readdirSync(projectsRoot)
  } catch {
    return null
  }
  const matches = entries.filter((e) => e.startsWith(prefix))
  return matches.length === 1 ? matches[0]! : null
}

const PROJECT_DIR_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The auto-memory directory Claude Code uses for a session launched in
 * `launchDir`, realpath'd when it exists. `env` must be the environment the
 * CLI sees (`claudeShellEnv`), not main's.
 *
 * Resolution: user-settings `autoMemoryDirectory`; else
 * `CLAUDE_CODE_PROJECT_DIR_NAME` (only alongside `CLAUDE_CONFIG_DIR`, as the CLI
 * does); else the first candidate project key whose memory dir exists, or the
 * first candidate when none does.
 */
export async function claudeMemoryDir(launchDir: string, env: ClaudeEnv): Promise<string> {
  const configured = userAutoMemoryDirectory(env)
  if (configured) return realpathOr(configured)

  const projectsRoot = join(claudeConfigDir(env), 'projects')
  const memoryFor = (key: string): string => join(projectsRoot, key, 'memory')

  const dirName = env.CLAUDE_CODE_PROJECT_DIR_NAME
  if (env.CLAUDE_CONFIG_DIR && dirName && PROJECT_DIR_NAME_RE.test(dirName)) {
    return realpathOr(memoryFor(dirName))
  }

  const keys = (await projectRootCandidates(launchDir)).map(encodeProjectKey)
  for (const key of keys) {
    const actual = key.length > PROJECT_KEY_MAX ? resolveOverCapKey(projectsRoot, key) : key
    if (actual && isDirectory(memoryFor(actual))) return realpathOr(memoryFor(actual))
  }
  return memoryFor(keys[0]!)
}
