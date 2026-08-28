---
"simpleedit": minor
---

Screen PRs is now a full review surface on the phone, not a read-only board.

Every PR opens the same way, whatever bucket it sits in. Buckets order the board — attention, quick, waiting, FYI, with stacks shown base-first — but they gate nothing: the anchoring problem that once argued for restricting approval to small PRs was already solved by `buildReviewPayload`, which anchors what it can to the diff's right-hand side and folds the rest into the review body so nothing is silently dropped. A PR opens onto two panes, Conversation and Files. Tapping any line in the diff opens a sheet to type or dictate a comment; triage and deep-review findings lift into the same draft carrying their own provenance. Deep review can be started from here and left running — its findings land whether or not you stayed on the screen.

Submitting is deliberate by construction. The verdict has to be tapped — approve is the shared default and must not become the outcome of not deciding — and submit opens a confirm naming the verdict, the anchored comment count and anything folded into the summary, computed by the same function that posts. Voice composes and never submits. A closed socket disables posting outright, and a connection that drops after the post is described as unknown rather than failed, because it is.

Comments hold to the commit they were written against. GitHub's reviews API carries no commit id — it anchors whatever you post against whatever the head is at that moment — so a force-push between reading a line and posting a comment on it used to put that comment on whatever had since taken the line, with no error and no warning. Each comment now records the commit its line was read off; if the branch moves under a draft, those comments lose their line and go into the review summary instead, and both the draft and the confirm say why. A line number of 0, which GitHub always rejects and which costs every other comment in the review its placement when it does, is no longer treated as an anchor at all.

Submitting is more careful about what it claims. A review whose result never came back latches: posting again takes an explicit "I checked GitHub", because reviews have no idempotency key and a second tap is how one review becomes two. A call that provably never left the device says so instead. The confirm dialog now takes focus and keeps it — Tab stays inside, Escape cancels while nothing is in flight, and focus returns to where it came from.

The board no longer ships every PR's full diff to a remote client. Screening spans every org where you are a reviewer, so that payload was megabytes for the sake of the one PR you open; the diff is now fetched when a PR is opened, cached per head commit.
