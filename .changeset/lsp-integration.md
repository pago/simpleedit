---
"simpleedit": minor
---

Add Language Server Protocol (LSP) integration for the Monaco editor

Connects Monaco to language servers (TypeScript, JavaScript, and others) via an
IPC-based JSON-RPC proxy. The main process resolves and spawns language servers
from the project's own `node_modules/.bin` first, falling back to PATH.

Features include go-to-definition, find all references, hover documentation,
completions, signature help, document highlights, and inline diagnostics.
Cross-file navigation works via Monaco's peek/reference overlay, which
auto-loads file content for files not yet open in the editor.

For TypeScript projects, the server uses the project's own `tsserver.js` so
type resolution matches the installed TypeScript version exactly.
