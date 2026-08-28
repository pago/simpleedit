---
"simpleedit": minor
---

Remote access gains its first real screens: a session list, the actual terminal, and a spoken reply.

Sessions are ordered by what is costing you throughput — blocked first, and a blocked session shows how long it has been blocked rather than how long it has been running, because that wait is a parallel slot doing nothing. The terminal is xterm over the real PTY through the same attachment the desktop uses, not a re-rendered interpretation of it, and an accessory bar supplies `↑ ↓ ⏎ Esc ⇥` — the keys a phone keyboard lacks and a TUI needs.

Replies can be dictated. Audio is captured in the browser and transcribed locally by whisper.cpp, which is detected rather than bundled: Settings names the Homebrew formula and the model file when either is missing. The transcript always lands in the composer for review before Send — dictation mangles branch names and file paths, and a wrong word in a live session is expensive — and typing works whether or not any of it is set up.

Also fixed: a client that disappeared kept its hold on a terminal's size forever, so the desktop window's resizes were dropped on behalf of a socket that no longer existed.
