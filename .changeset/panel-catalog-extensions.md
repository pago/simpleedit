---
"simpleedit": minor
---

Four additive extensions to the composed-panel catalog, all backward compatible.

- New `focus_block` action: a panel element can now scroll to another block of the *same* panel and flash it, expanding any collapsed `Section` on the way. It is the first panel-local action — it never crosses the MCP bridge or IPC — so a "Read in this order" `FileList` at the top of a code tour can jump to each file's `DiffBlock` without a checkout and without dropping the reader out of the tour. A `blockId` that names no element of the spec is rejected as a dead link before the panel opens.
- `Diagram` takes an optional `title`, rendered as a heading on the diagram itself, so naming one no longer costs a `ProseBlock` above it.
- `Callout.body` renders markdown, through the same path as `ProseBlock`. It previously did not even preserve newlines, which forced every callout down to a single claim.
- `FileList.detail` wraps below the path in full instead of being truncated to a single line, so a row can say *why* the file is in the list.

Fixes: no composed-panel action has ever dispatched. `ComposedPanel` passed `state`/`actions` to `JsonUIProvider`, whose props are `initialState`/`handlers`, so every `open_file`, `show_diff`, `send_to_agent` and `dismiss_panel` click logged "No handler registered for action" and did nothing.
