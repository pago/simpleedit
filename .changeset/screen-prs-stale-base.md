---
"simpleedit": minor
---

Screen PRs spots stacked PRs whose lower layer was rebased, where GitHub's diff
shows the whole stack. The PR detail on the desktop and the phone warns about it,
and where the PR's own commits can be separated, triage, deep review and the diff
view read only those commits. A rebased base now re-triages the PR even when its
head hasn't moved.
