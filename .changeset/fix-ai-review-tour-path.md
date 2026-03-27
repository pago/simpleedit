---
"simpleedit": patch
---

Fix AI Review and AI Tour failing to find `claude` in packaged builds.

Both features spawned `claude` by bare name, which fails when the app is packaged because the system `PATH` does not include shell-configured directories (nvm, Homebrew, etc.). They now resolve the full path to `claude` via an interactive login shell (`which claude`) — the same approach used for the Claude terminal — before spawning the subprocess.
