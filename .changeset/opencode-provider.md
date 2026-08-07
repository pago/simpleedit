---
"simpleedit": minor
---

Add OpenCode as a third first-class agent provider.

OpenCode sessions launch, resume and fork like Claude and Codex ones, report
precise status, track the files and repos they touch, name themselves from the
conversation, and take part in agent-to-agent messaging. Its models appear in
the session picker, the default-model setting and the deep-review lenses, and
Review and Tour can run on it as a bounded, read-only runner.

Unlike the other two, OpenCode reports nothing back over hooks — its TUI hosts
the opencode HTTP server, so SimpleEdit launches it on a port it chose and
subscribes to that server's event stream instead. Providers can now describe
this with an `attach` lifecycle, so status and tracking work with no one-time
trust grant of the kind Codex needs.

Two fixes fall out of this that apply to Claude and Codex as well:

- A session started on an explicitly chosen model was labelled with the model id
  and frozen there for its whole life. That label is now a stand-in an agent's
  own conversation title may replace; a name you chose still wins.
- Pickers that offered a reasoning effort per model built their option keys
  without the effort unless the provider was Codex, so variants of one model
  could collide.
