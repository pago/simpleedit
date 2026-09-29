---
"simpleedit": minor
---

The phone app now has real navigation. The system Back — an iOS swipe-back, Android's Back button, a browser's Back — closes whatever is on top (a sheet, a commit's diff, a PR, a session) instead of leaving the app, and asks first when that would throw away a brief or a comment you have typed. Tapping a notification opens its session on top of what you were doing, so Back returns there with your draft intact. Each tab keeps its own place: switching between Sessions and PRs no longer closes the screen you had open or loses the list's scroll, and the tab bar now stays available on detail screens. A PR's Conversation and Files panes each keep their scroll when you flip between them.
