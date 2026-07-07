---
"simpleedit": minor
---

Add `runFanout` to the bounded-task orchestrator: run a task over N inputs with
capped concurrency, streaming per-input lifecycle events (`start`/`item`/`done`/
`error`) as they land. This is the fan-out substrate the upcoming Screen PRs
feature is built on; a single input's failure is isolated to its own `error`
event and never rejects the whole stream. Also lands the Screen PRs design docs.
