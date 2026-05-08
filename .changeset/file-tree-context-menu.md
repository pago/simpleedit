---
"simpleedit": minor
---

Add a right-click context menu to the file tree with **New File**, **New Folder**, **Rename**, and **Delete** actions. New File/Folder accept nested names like `foo/bar.ts` to create intermediate directories. Delete moves to the OS trash via `shell.trashItem` so items are recoverable. The affected portion of the tree refreshes automatically after each operation.
