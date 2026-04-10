---
"simpleedit": minor
---

Add Claude-originated plan support via MCP bridge. When Claude Code calls the `show_plan` MCP tool from an interactive terminal session, the plan is displayed in Plan Mode with a feedback loop back to the originating session. Includes plan persistence across app restarts, toast notifications, session-aware task routing, and per-task feedback that routes to Claude.
