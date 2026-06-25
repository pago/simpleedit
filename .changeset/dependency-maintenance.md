---
"simpleedit": minor
---

Dependency maintenance sweep.

- Upgraded Electron 35 → 42, picking up several HIGH-severity Chromium/Electron
  security fixes (use-after-free in offscreen paint, permission callbacks, and
  PowerMonitor). Bundled Node goes 22 → 24; node-pty is rebuilt for the new ABI.
- Upgraded the build toolchain to Vite 7 (electron-vite 5, vite-plugin-svelte 6).
- Upgraded TypeScript 6, xterm 6, chokidar 5, vscode-jsonrpc 9, monaco-editor
  0.55, and @json-render/svelte 0.19.
- Refreshed all in-range dependencies, including security fixes for simple-git
  (RCE), vitest (dev-only), and dompurify; removed the unused @anthropic-ai/sdk.
