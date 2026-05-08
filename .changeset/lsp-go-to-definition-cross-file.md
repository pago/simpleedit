---
"simpleedit": patch
---

Make Go to Definition (and Ctrl/Cmd-click) actually open the target file when it lives in another module. Previously Monaco fell back to the peek widget because the standalone editor's URI opener doesn't know about our tab system; now we register a Monaco editor opener that routes the request through the active pane's `openFile`, and the loaded editor scrolls/selects the LSP-resolved position automatically.
