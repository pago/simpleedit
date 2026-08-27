---
"simpleedit": minor
---

Add **Remote access**: a Settings pane that serves SimpleEdit to a browser on
this machine or over Tailscale, so a session can be reached from another
device.

It is **off by default** and starts only when you turn it on. The link it
gives you carries a random access token that is regenerated on every start,
and it is bound to an interface you choose explicitly — loopback by default,
never all interfaces. Anyone holding the link can run terminals, edit files and
remove worktrees, so treat it as a password.

While remote access is on, SimpleEdit holds a power assertion so the Mac does
not sleep and stop your agents. The pane shows whether that assertion is
actually held.

Also: a terminal is now told when another window or device takes over its size,
instead of quietly rendering at a width the terminal no longer uses.
