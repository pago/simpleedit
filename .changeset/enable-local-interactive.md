---
"simpleedit": patch
---

Enable interactive local (Ollama) coding sessions. Claude Code's `count_tokens` probe was hanging Ollama's Anthropic-compatible endpoint (Ollama #13949); setting `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` on the local spawn sidesteps it, so tool-capable local models are now startable interactively from the model picker (on by default).
