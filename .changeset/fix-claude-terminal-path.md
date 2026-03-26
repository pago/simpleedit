---
"simpleedit": patch
---

fix: source ~/.zshrc in Claude terminal so claude is found on PATH

The previous fix used a login shell (-l) which sources ~/.zprofile but not ~/.zshrc. Tools installed via nvm, npm global installs, or other ~/.zshrc-based PATH modifications were not available. Adding -i (interactive) ensures both files are sourced.
