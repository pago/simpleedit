---
"simpleedit": minor
---

Pair a phone from the Remote access pane with a QR code, and drive `tailscale serve` from it.

Getting the remote URL onto a phone meant retyping a 64-hex-character token, and reaching it
at all meant hand-running `tailscale serve` and rediscovering the ephemeral port every time it
changed. The pane now shows a scannable code for the URL a phone can actually reach — never
for loopback, which would resolve to the phone itself — and can create and remove the serve
mapping for you.

SimpleEdit also detects Tailscale properly now, through its CLI rather than by pattern-matching
an interface name: it reports the node's MagicDNS name and whether HTTPS certificates exist,
and it says plainly when the installed copy is the sandboxed Mac App Store build, which ships
no CLI it can drive. When a tailnet has never had Serve switched on, the node-specific admin
link buried in the CLI's error is pulled out and rendered as a link instead of a dead end.
