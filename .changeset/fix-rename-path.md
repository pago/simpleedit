---
"simpleedit": patch
---

Fix renamed files showing a broken path in the diff review file list. Git outputs `R100\told\tnew` for renames, but the parser joined both paths with a tab. Now correctly uses the new (destination) path.
