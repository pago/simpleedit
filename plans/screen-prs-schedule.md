# Scheduled background screening

Goal: Screen PRs re-runs on its own every Off / 1h / 2h / 4h / 16h.

Locked (2026-10-13): badge-only signal; the schedule runs in main and keeps going
with no windows open (quit still stops it); the interval lives in the saved filter,
shown in the Screen PRs filter bar on desk and phone.

## Shape
- `shared/screenprs-filter.ts`: `AUTO_SCREEN_HOURS = [0,1,2,4,16]`, `autoScreenHours`
  in prefs (missing on disk → 0; missing in a set → keep current, so an old phone
  build can't switch it off).
- `main/screenprs-schedule.ts`: one `setTimeout` to `lastAt + interval` (floor: now +
  30 s), `lastAt` persisted (`screenprs-schedule.json`) and stamped by *every* run
  start (manual included, via `onScreeningStarted`). Re-armed on filter change,
  run start, `powerMonitor` resume (timers stall across sleep). Skips while a run
  is going. Broadcasts `screenprs:schedule-changed` {lastAt, nextAt}; also in
  `screenprs:state`.
- Scheduled runs are **refreshes**: the board is kept, `queued` drops PRs that left
  the queue and keeps existing cards until their new card lands. A manual Screen
  still clears.
- `window-all-closed` no longer cancels screening.

## Status
- [ ] shared + tests
- [ ] main scheduler + refresh run + tests
- [ ] store + desk + phone UI
- [ ] CLAUDE.md, changeset, delete this file
