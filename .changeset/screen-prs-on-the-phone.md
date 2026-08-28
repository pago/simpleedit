---
"simpleedit": minor
---

Screen PRs is now a full review surface on the phone, not a read-only board.

Every PR opens the same way, whatever bucket it sits in. Buckets order the board — attention, quick, waiting, FYI, with stacks shown base-first — but they gate nothing: the anchoring problem that once argued for restricting approval to small PRs was already solved by `buildReviewPayload`, which anchors what it can to the diff's right-hand side and folds the rest into the review body so nothing is silently dropped. A PR opens onto two panes, Conversation and Files. Tapping any line in the diff opens a sheet to type or dictate a comment; triage and deep-review findings lift into the same draft carrying their own provenance. Deep review can be started from here and left running — its findings land whether or not you stayed on the screen.

Submitting is deliberate by construction. The verdict has to be tapped — approve is the shared default and must not become the outcome of not deciding — and submit opens a confirm naming the verdict, the anchored comment count and anything folded into the summary, computed by the same function that posts. Voice composes and never submits. A closed socket disables posting outright, and a connection that drops after the post is described as unknown rather than failed, because it is.

The board no longer ships every PR's full diff to a remote client. Screening spans every org where you are a reviewer, so that payload was megabytes for the sake of the one PR you open; the diff is now fetched when a PR is opened, cached per head commit.
