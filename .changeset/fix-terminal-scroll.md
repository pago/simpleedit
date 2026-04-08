---
"simpleedit": patch
---

Fix terminal scrolling to top when content arrives or the container resizes. Scroll position is now preserved across fit() calls, tab switches, and incoming PTY data when the user has scrolled up.
