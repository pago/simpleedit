---
"simpleedit": patch
---

Agent-to-agent messages now reach idle sessions. When a session sitting at its prompt gets mail, SimpleEdit submits a short notice telling it to call `check_inbox`. It doesn't do this while you have unsent text in that prompt. Replies arrive the same way, as an ordinary message instead of a Stop-hook "blocking error". `send_message`, `list_sessions` and timed-out `wait_for_reply` calls now say whether a message is still queued, has been announced, or has been read. Sessions started with `spawn_session` are told their spawner's session id, so they can report back. A badge in the sidebar shows unread agent mail. Mail is no longer handed to a sub-agent's stop, where the session itself never saw it.
