---
"simpleedit": minor
---

Homebrew installs can now update themselves. The update banner offers **Update & Restart**, which quits SimpleEdit, runs `brew upgrade`, and reopens it — the first working one-click update on macOS, where Squirrel's signature check has always rejected the ad-hoc signed bundle.

The upgrade runs in a detached helper rather than as a child process, which matters because SimpleEdit is a terminal. A `brew upgrade` started from inside SimpleEdit is a descendant of the bundle being replaced, so quitting the app would kill the upgrade midway — after Homebrew moved the old bundle aside and before the new one was in place. The helper instead waits for the app to exit, verifies no instance was reopened, then upgrades and relaunches.

Because it runs with no window open, a failed background upgrade is reported on the next launch, with a button to open the helper's log.
