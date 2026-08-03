---
"simpleedit": patch
---

Fix the update banner's dead "Restart & Update" button on macOS. electron-updater
reports `update-downloaded` as soon as its local proxy is listening, before
Squirrel has fetched and signature-checked the bundle, so the banner offered a
restart that silently waited forever for a staging event that never arrived
(ad-hoc signed builds fail Squirrel's signature check). The banner now waits for
Squirrel to actually stage the update, reports updater failures — worded by which
step failed, and ignoring routine check failures — with a manual download link,
and always gives feedback on a click. Also pad the banner clear of the macOS
traffic lights, which float over it.
