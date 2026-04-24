---
"simpleedit": minor
---

Add `complete_task` MCP tool that lets Claude agents deliver a guided review tour directly when they finish a chunk of work — no separate Claude spawn, richer context, lower cost. Tours attach to the provided commit hash or to staging. Open questions render as an attention banner plus a list below the tour. Tool descriptions for `show_plan` and `complete_task` are directive ("ALWAYS use this tool when…") so agents pick them up without prompting.
