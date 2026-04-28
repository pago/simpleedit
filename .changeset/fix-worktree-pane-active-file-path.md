---
"simpleedit": patch
---

Fix critical startup crash where opening any repo threw `ReferenceError: activeFilePath is not defined` from `WorktreePane`'s `<FileTree>` call. The reference was added by the "Select opened file" feature against pre-tabs-refactor code; after the unified tab model landed, `activeFilePath` is no longer a local — derive it from the active tab instead. The render error cascaded into git log not loading and worktree clicks appearing inert because Svelte aborted the reactive batch.
