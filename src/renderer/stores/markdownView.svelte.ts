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

import { SvelteMap } from 'svelte/reactivity'

export type MarkdownViewMode = 'raw' | 'hybrid' | 'rendered'

const DEFAULT_MODE: MarkdownViewMode = 'rendered'

// SvelteMap (not a plain `$state(new Map())`) so per-key `.get()`/`.set()` are
// tracked. With a plain Map a reader's `get(path)` dependency is dropped once
// the path has an entry (the `?? _lastChosen` fallback short-circuits), so the
// view mode locked after the first switch.
const _modes = new SvelteMap<string, MarkdownViewMode>()
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
