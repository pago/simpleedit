/**
 * Strip characters illegal in git branch names (see git-check-ref-format).
 * Used for both the sidebar's "new worktree" form and the fork picker's
 * create-new-worktree field so the two surfaces sanitize identically.
 */
export function sanitizeBranchName(input: string): string {
  return input
    .replace(/[\s~^:?*[\]\\@{]/g, '') // illegal characters
    .replace(/\.\./g, '.') // no consecutive dots
    .replace(/\/\//g, '/') // no consecutive slashes
    .replace(/\.lock(\/|$)/g, '$1') // no .lock component
    .replace(/^[./]/, '') // cannot start with . or /
}

/** A sanitized branch name is valid when it's non-empty and doesn't end in `.` or `/`. */
export function isValidBranchName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && !trimmed.endsWith('.') && !trimmed.endsWith('/')
}
