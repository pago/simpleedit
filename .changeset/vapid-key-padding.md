---
"simpleedit": patch
---

Fix phone push notifications occasionally unregistering every device: about one in 256 generated signing keys was saved one byte short, rejected as invalid on the next load, and replaced along with all subscriptions. Keys already saved that way are now repaired on load, so those phones stay registered.
