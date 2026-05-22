---
"simpleedit": patch
---

Fix Claude session_id capture for fresh tabs. The CLI's `--output-format
stream-json` is silently ignored when stdin is a TTY (which `node-pty`
always provides), so the existing stream-json parser in `claude-stream.ts`
captured nothing for any fresh Claude tab — breaking the rename-restore
feature and blocking the Fork-into-worktree precursor.

Replaced the broken path with `--session-id <uuid>`: mint a UUID with
`crypto.randomUUID()` at spawn time, pass it on the claude CLI, and emit
`claude:session-id` synchronously to the renderer. No filesystem watcher
or first-message race involved.
