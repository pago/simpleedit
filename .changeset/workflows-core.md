---
"simpleedit": minor
---

Workflows: a lead agent can turn a plan into a task graph (`create_workflow`) that SimpleEdit runs with hidden worker sessions. The lead's new Workflow tab shows the graph, what needs you, and each worker's terminal in a popup; press Start to run it. Workers report with `report_result`, failures retry or escalate to the lead, and running workflows pick up their workers again after a restart.
