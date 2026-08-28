---
"simpleedit": minor
---

Push notifications when a session blocks on you.

A phone gets one notification when an agent stops and needs a reply, and
nothing else. Tapping it opens straight into that session with the composer
ready — never the microphone, which iOS requires a gesture for and which would
be wrong on wake regardless.

The trigger is deliberately narrow, because the feature's whole value is that a
buzz means something: only a status the agent reported itself, only the
transition into blocked, debounced per session, nothing while you are at the Mac,
and nothing at all while remote access is off. It covers every provider, which is
why it exists — Claude Code's own Remote Control notifies for Claude alone.

Claude sessions now launch with the `Notification` hook wired, which is the only
signal Claude Code emits meaning "I need you" — a tool awaiting permission, or a
prompt left unanswered. None of it reaches the terminal title, so nothing could
see it before; its text becomes the notification body.

Messages are Web Push with VAPID, encrypted end to end, so Apple relays them
without being able to read them. Subscriptions belong to the device that made
them and survive a restart; an endpoint the push service reports as gone is
dropped rather than retried forever.

Settings → Remote access explains the one step that cannot be automated: iOS
only allows notifications for a page added to the Home Screen. It also lists
registered devices, by push service rather than by address, and can forget them.

While a SimpleEdit window is focused and the machine has seen recent input,
SimpleEdit writes the marker file Claude Code reads through
`CLAUDE_CLIENT_PRESENCE_FILE`, so a Claude session does not buzz twice. Idle
time is part of that check on purpose: a window left focused while you are out
would otherwise look like you are at your desk forever.
