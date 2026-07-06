---
"simpleedit": minor
---

Local & alternate model support. A new Settings window lets you discover, install (with hardware-aware recommendations), and pick Ollama or Claude models, and set per-feature default models for Review and Tour. Under the hood the hardwired Claude integration is generalized into an `AgentProvider` abstraction, and Review and Tour now run on a shared bounded-task substrate that can target a chosen model — cloud via Claude Code, or a local model via Ollama's native API. Interactive local sessions via Claude Code are intentionally disabled pending an upstream Ollama fix (#13949); local models power the Review/Tour tasks instead.
