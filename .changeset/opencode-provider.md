---
"simpleedit": minor
---

Add OpenCode as a third first-class agent provider.

OpenCode sessions launch, resume and fork like Claude and Codex ones, report
precise status, track the files and repos they touch, and take part in
agent-to-agent messaging. Review and Tour lenses can run on OpenCode as a
bounded, read-only runner.

Unlike the other two, OpenCode reports nothing back over hooks — its TUI hosts
the opencode HTTP server, so SimpleEdit launches it on a port it chose and
subscribes to that server's event stream instead. Providers can now describe
this with an `attach` lifecycle, so status and tracking work with no one-time
trust grant of the kind Codex needs.
