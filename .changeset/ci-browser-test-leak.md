---
"simpleedit": patch
---

Stop the editor-opener browser test from leaking unhandled Monaco TypeScript-worker rejections that were failing CI even though every assertion passed.
