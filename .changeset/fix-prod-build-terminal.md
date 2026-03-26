---
"simpleedit": patch
---

Fix production build packaging and terminal issues

- Add `.DS_Store` to `.gitignore`
- Add `shamefully-hoist=true` to `.npmrc` so electron-builder can resolve transitive pnpm dependencies (fixes "Cannot find module 'ms'" on startup)
- Spawn Claude terminal with a login shell (`zsh -l -c`) so `claude` is found on PATH when the app is launched via macOS GUI rather than a terminal
