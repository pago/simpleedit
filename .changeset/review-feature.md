---
"simpleedit": minor
---

Add AI-powered diff review with streaming findings

Introduces a "✦ Review" button in the diff view that spawns Claude to analyze
the current diff and stream back structured findings using Conventional Comments
labels (praise, nitpick, suggestion, issue, question, thought, chore).

Findings appear progressively as Claude streams them, are sorted by severity,
and can be navigated to in the diff editor with line highlighting. Bulk operations
allow dismissing multiple findings or forwarding them to an agent terminal with
a custom instruction.

Works for both commit diffs and uncommitted (staged) changes.
