---
"simpleedit": patch
---

Two fixes on the paths a phone review runs through.

A call made over remote access in the moment a connection was going down could be reported as failed and then still be delivered, seconds later, on the reconnect — because the frame was buffered while the promise was rejected. For a review submit that meant it could post after you had been told it might not have, and post a second time if you retried. Buffered frames now live and die with the socket they were written for, and a call that provably never left the device says so, rather than leaving the outcome open.

The diff parser read `+++ ` and `--- ` as file headers anywhere in a diff, so an added line whose own text begins `++ ` — a nested markdown bullet, a note about C++ — was taken for a new file: the path changed and every line after it was numbered against the wrong hunk. Those two are file headers only before the first hunk.
