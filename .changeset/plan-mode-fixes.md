---
"simpleedit": patch
---

Fix plan mode: deduplicate plan form and auto-complete tasks when Claude finishes.

- PlanView no longer shows two description forms (PlanPanel's empty-state input is suppressed when embedded in PlanView)
- Plan tasks now transition from "in-progress" to "done" when the associated Claude terminal goes idle
- claude:status IPC event now includes terminalId for per-terminal tracking
