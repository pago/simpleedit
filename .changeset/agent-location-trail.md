---
"simpleedit": minor
---

Sessions now track the agent's location trail across repos and worktrees. When
an agent works in a repo the window never opened, the hook handler resolves and
registers it so it surfaces automatically. The repo picker becomes a dropdown
over the repos this agent has worked in (switching one lands on its
most-recently-touched worktree), and the worktree picker pins touched worktrees
to the top — most-recent first — above a separator, then the rest
alphabetically. The view only follows the agent while the Files viewer is
closed; with it open, an amber indicator marks where the agent moved instead of
swapping out what you're reviewing. The trail persists with resumable sessions.
