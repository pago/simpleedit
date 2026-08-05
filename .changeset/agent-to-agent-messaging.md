---
"simpleedit": minor
---

Agent sessions can now message each other. An agent lists its peers
(`list_sessions`), sends a message (`send_message`, optionally waiting for the
answer), replies (`reply`), and reads its inbox (`check_inbox`). `spawn_session`
now returns the new session's id, so an agent can delegate work and then collect
the result instead of the user copy-pasting between sessions.

Mail is delivered at turn boundaries through the session's Stop hook, and the
recipient's ordinary answer is relayed back automatically — it does not have to
call any tool to reply. Exchanges are bounded by a hop budget, a per-sender rate
limit, and a message size cap.
