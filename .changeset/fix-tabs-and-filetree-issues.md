---
"simpleedit": patch
---

Fix three bugs in the v0.11 tab/file-tree code:

- **tabsStore peek-replace leaked stale ids.** When peek B replaced peek A, A's id stayed in the MRU and unread sets and (in the background-replace case) as `activeId`. After a peek-peek-close sequence the pane's `activeId` could point at a tab that no longer existed, defeating the `paneIdle` heuristic — agent plans/tours/panels then opened in the background unread instead of focusing into a visibly empty pane. The replaced peek's id is now pruned, and active focus transfers to the replacement when the slot was the focused one.
- **Agent panel updates were silent in the background.** `tabsStore.open` only adds the unread marker for *new* tabs. When `show_panel` updated a panel the user already had open in the background, no marker appeared. `WorktreePane` now adds the marker explicitly when an existing, unfocused panel gets refreshed.
- **FileNode `loadChildren` race.** `toggle()` and the "Select opened file" reveal effect can each kick off a `loadChildren()` for the same node. If the later call resolved first, an older response could overwrite `children` with stale data. Added a sequence counter so only the most recent call wins.

Also drops a dead `openDiffTab` import from `WorktreePane.svelte`.
