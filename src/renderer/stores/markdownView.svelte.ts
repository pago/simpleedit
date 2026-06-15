/**
 * Per-file Markdown view mode (raw / hybrid / rendered).
 *
 * Kept out of the generic `FileTab` model on purpose — view mode is a
 * Markdown-only concern and shouldn't leak into the shared tab shape. The
 * toggle (in the tab bar) and the content (under `TabContainer`) live in
 * sibling subtrees and must agree, which is what makes this global state.
 *
 * Keyed by absolute file path: file tab ids are `file:<absolute-path>`, so a
 * path is unique across worktrees, and two panes showing the same worktree
 * share the same path → they share the view mode (matching the shared tab list).
 */

export type MarkdownViewMode = 'raw' | 'hybrid' | 'rendered'

const DEFAULT_MODE: MarkdownViewMode = 'rendered'

let _modes = $state<Map<string, MarkdownViewMode>>(new Map())
// Remembered most-recent choice, used as the default for files not yet seen.
let _lastChosen = $state<MarkdownViewMode>(DEFAULT_MODE)

export const markdownViewStore = {
  /** Mode for a file, falling back to the most-recently-chosen mode. */
  get(path: string): MarkdownViewMode {
    return _modes.get(path) ?? _lastChosen
  },

  set(path: string, mode: MarkdownViewMode): void {
    _modes.set(path, mode)
    _lastChosen = mode
  },

  /** Drop a file's stored mode (e.g. when its tab closes). */
  forget(path: string): void {
    _modes.delete(path)
  },
}
