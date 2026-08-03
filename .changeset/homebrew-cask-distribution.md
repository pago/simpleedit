---
"simpleedit": minor
---

Install and update SimpleEdit on macOS with Homebrew: `brew install --cask pago/simpleedit/simpleedit`. The cask clears the download quarantine flag, so there is no Gatekeeper detour on first launch, and `homebrew.yml` publishes each released version to the tap automatically.

A Homebrew-installed copy can't be replaced by the in-app updater — Squirrel rejects the ad-hoc signature — so it no longer tries. The update banner now recognises a Homebrew install and offers the `brew upgrade` command instead of a restart button that could never work.
