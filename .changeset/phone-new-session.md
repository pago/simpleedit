---
"simpleedit": minor
---

Start a session from the phone. The Sessions screen gets a `+` that opens a
voice-seeded new-session sheet: one field, the brief, dictated through the same
composer the reply uses (transcript review included) or typed. Provider and
model come from the same default ⌘T uses — a phone is not where you
comparison-shop models — and the session's name is the brief's first clause
until the agent renames it.

A session is created exactly once per confirmed intent: the request carries an
intent id and main de-duplicates against it, so a double tap, a socket that
drops before the answer arrives, or a retried call all resolve to the one
session. The web `window.api` shim no longer replays a queued call whose
promise it already rejected, which was the other way one confirmation became
two.

The brief's provisional name is a stand-in, not a choice: the agent replaces it
with its own conversation title exactly as it does at the desk. The sheet traps
focus, leaves on Escape, and warns before the browser takes an unsent brief. If
a start times out, its outcome is genuinely unknown — so rather than silently
starting a second agent, there is an explicit "Start a new session anyway" that
keeps the brief and names the risk.
