---
"simpleedit": minor
---

Markdown files now open with raw / hybrid / rendered view modes, toggled from a control on the right of the tab bar (WebStorm-style). The rendered preview parses Markdown with `marked` + DOMPurify, renders mermaid diagrams and Monaco-themed syntax highlighting in fenced code blocks, resolves relative images via a worktree-scoped `wt-asset:` protocol, and keeps scroll position anchored between editor and preview in hybrid mode.
