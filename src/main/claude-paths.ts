/**
 * Filesystem-layout helpers for Claude Code's per-project storage.
 *
 * The CLI stores per-cwd state under `~/.claude/projects/<encoded-cwd>/`,
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
import { realpathSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Encode an absolute path the same way the Claude CLI does to derive its
 * `~/.claude/projects/<...>/` directory name. Resolves symlinks first.
 */
export function claudeProjectDirName(absPath: string): string {
  return realpathSync(absPath).replace(/[^A-Za-z0-9]/g, '-')
}

/** Absolute path of the projects directory the Claude CLI uses for `cwd`. */
export function claudeProjectsDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', claudeProjectDirName(cwd))
}
