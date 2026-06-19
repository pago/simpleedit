---
"simpleedit": patch
---

Fix: a repo the agent only **reads or edits a file in** (without `cd`-ing there) now appears in the session's repo picker. Repo tracking previously keyed solely off the hook `cwd`, which a Read/Edit/Write never moves, so sibling repos stayed invisible. `PostToolUse` now also resolves the touched `file_path` to its repo and records it on the trail — without repointing the workspace view.
