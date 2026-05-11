---
"simpleedit": patch
---

Fix typing wiping out the user's input. When the user typed a character, the resulting modified-flag flip caused the parent to re-render, the load-file `$effect` re-fired even though `filePath` was unchanged, and `loadFile` then reset the model to the disk contents — erasing the typed character and dropping the cursor at (1, 1). The effect now skips when the path matches what's already loaded.
