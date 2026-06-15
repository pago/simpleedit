---
"simpleedit": minor
---

Remove Plan Mode. The structured plan view (NDJSON task list with reactions,
status cycling, and per-task agent dispatch) forced plans into a data model
that couldn't represent the prose, diagrams, and narrative that make a plan
useful, and the resulting UI was cluttered. Planning is better served by a
markdown document plus the existing terminal, so the feature has been dropped:
the `show_plan` MCP tool, the headless plan generator, the `plan:*` IPC
channels, the `plan` tab kind, and the Git Log "✦ Plan" button are all gone.

Sessions saved by older builds that contain a plan tab restore cleanly — the
stale tab is skipped on hydrate.
