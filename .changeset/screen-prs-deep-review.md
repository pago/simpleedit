---
"simpleedit": minor
---

Screen PRs — deep-review engine. A chosen PR can now run a thorough, multi-lens
review: focused lenses (soundness, intent-vs-impl, test coverage, and optional
type/architecture) run in parallel, then a synthesis pass dedups/ranks/drops
noise. Mostly local by default (each lens inherits the triage model unless
escalated to cloud in Settings); soundness/intent/tests on by default,
type/architecture opt-in. Concurrency is gated per backend (local-serial for the
GPU, cloud-parallel). The PR detail gains a Deep review action with live lens
progress and a curated, severity-ranked findings list; triage collapses once
deep review supersedes it. Findings are diff-only for now (repo-aware pass on a
checked-out worktree follows with Discuss/handoff).
