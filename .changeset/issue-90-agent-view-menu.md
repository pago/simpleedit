---
"simpleedit": minor
---

Fixes #90: right-clicking the new-Claude (✦) button in the terminal tab strip opens a context menu offering "New Claude session" (existing behavior) or "New Agent View session" (`claude agents` — interactive TUI). Shift+F10 and the ContextMenu key also open the menu for keyboard users. Agent View tabs are labelled `Agents` / `Agents N` and spawn through a new `claude:spawn-agents` IPC channel that intentionally skips stream-json parsing and the MCP bridge. Known limitation: Agent View tabs cannot be true session-restored (claude agents emits no session-id), so on app restart they respawn fresh as a new Agent View tab in the original position — position and label persist, in-tab state does not.

Also extracts a reusable `ContextMenu.svelte` with arrow-key navigation, disabled-item skipping, danger tone, separators, and focus restoration. `FileTreeContextMenu` is unchanged in this PR and will be migrated to the shared component later.
