---
"simpleedit": patch
---

Fix missing native modules in packaged builds — remove the blanket node_modules exclusion from electron-builder so all production dependencies (simple-git, chokidar, vscode-jsonrpc, node-pty) are correctly bundled
