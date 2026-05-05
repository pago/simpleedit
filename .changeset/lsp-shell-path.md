---
"simpleedit": patch
---

Inherit the user's shell PATH on macOS/Linux when launched from Finder/Spotlight, so language servers (and other binaries on PATH like `asdf` shims, homebrew, nvm) can be found. LSP startup failures are also now logged to the renderer console instead of being silently swallowed.
