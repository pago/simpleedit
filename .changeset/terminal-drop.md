---
"simpleedit": minor
---

Drag and drop files onto the terminal to attach them. Drops from Finder paste the absolute path; drops from a browser or anywhere else without a filesystem path are saved to a temp file under `simpleedit-drops/` and the path is pasted instead. Multiple paths use newline separators in Claude terminals (matching Claude Code's parser) and shell-escaped, space-separated paths everywhere else.
