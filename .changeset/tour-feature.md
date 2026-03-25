---
"simpleedit": minor
---

Add AI-powered changeset tour with commit and branch modes

Introduces a "Tour" tab in the diff review that generates an AI-narrated
walkthrough of a changeset, grouped by logical topic. Each topic includes
prose explaining what changed and why, with lazy-mounted compact inline diff
editors for relevant code hunks.

**Commit tour:** Click "✦ Tour" on any commit or staged changes to get a
guided walkthrough. Topics stream in progressively and are persisted to disk.

**Branch tour:** Click "✦ Tour Branch" in the Git Log header to tour all
changes on the current branch compared to main. The overview is editable
and can be copied as a PR description.

For staging tours, the overview is editable and can be used as a commit
message. Editing the overview and clicking "Re-generate" feeds the correction
back to Claude for a more accurate tour.
