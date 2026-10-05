---
"simpleedit": patch
---

Fixes from a round of phone and review testing:

- Closing Settings while remote access is on no longer shows "A JavaScript error occurred in the main process".
- Send on the phone now submits the reply to Claude Code and Codex, instead of leaving it in the agent's prompt for another Enter.
- Tapping a text field on the phone no longer zooms the page and pushes Send off-screen.
- A gen-UI panel's reply to the agent (a decision card's option, for example) is now submitted whatever its length; long ones used to stay in the prompt.
- A note sent to an agent from the desktop review is now always staged in its prompt, never submitted, so several notes can be collected and submitted together.
- Settings › Remote access follows the setup order: how the phone reaches this Mac (network interface and Tailscale), then the pairing code, then the rest.
- A diff's horizontal scrollbar no longer covers its last line and that line's comment button.
