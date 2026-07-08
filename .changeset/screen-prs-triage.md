---
"simpleedit": minor
---

Screen PRs — triage logic layer (main process). Adds the GitHub read adapter
(`gh` search / view / diff / checks), the diff-only per-PR triage task (cheap
local model via DirectRunner), deterministic bucketing (shared, so the renderer
re-sorts as cards stream), and the fan-out orchestration + `screenprs:*` IPC that
gathers the review queue, judges each PR, and streams bucketed cards. The
split-view panel UI follows.
