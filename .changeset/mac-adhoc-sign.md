---
"simpleedit": patch
---

Ad-hoc sign the macOS build so it no longer reports "SimpleEdit is damaged and can't be opened" after download. An `afterPack` hook (`scripts/mac-adhoc-sign.cjs`) signs the fully-assembled bundle — including the node-pty and mcp-server payloads — with an ad-hoc signature, and electron-builder's own signing is disabled so that signature is authoritative. Builds remain unsigned by Developer ID, so first launch still requires bypassing Gatekeeper once (System Settings → Privacy & Security → "Open Anyway", or `xattr -dr com.apple.quarantine /Applications/SimpleEdit.app`).
