# TDD evidence: fragility plan, Phase 3 (adaptive timing, precise status)

**Source plan:** the fragility audit in the session, items C3, S1, S2 (plan items 9-11).
Phase 2 and the same-name split were committed first (aa688e2). **Checkpoint commits:** not made
for the RED/GREEN stages (the owner commits on request); this report stands in.

## User journeys

- As a user, I want my sounds to keep working if WhatsApp becomes slower to play its own sound.
- As a user, I want the status line to tell me WHY my sound did not play: blocked by the browser
  (click once) or the sound file itself failing (upload it again).
- As a user, I want to be told if the extension can no longer read WhatsApp's chat list.

## What was built

| Part | What it does |
| ---- | ------------ |
| `main-hook.mjs` | Measures how long WhatsApp takes to play its sound after a notification, including a known incoming sound arriving after the window closed (within 3 s). Pairing window = 3x the slowest of the last 10 delays, 0.5-2 s; waiting for WhatsApp before playing ours = 2x + 50 ms, 0.15-1 s. Kept across reloads under `wanscTiming` (numbers only, checked). |
| `health.mjs` | `blockedRun` and `failedRun` separate, statuses `play-blocked` and `play-failed`; `soundDelayMs`; chat-list readability (`page`: readable, unreadable checks in a row, which layer) and status `list-unreadable` after 3. Diagnostics include timing and how the list is read, from a fixed vocabulary. |
| `page-model.mjs` | `layers()`: whether the list, names and counters were found by what was learned, WhatsApp's own names, structure, labels, or not at all. |
| `bridge.mjs` / `bridge.entry.mjs` | `bridge.report()`; the chat list is checked once a minute. |

```text
npx vitest run tests/unit/timing-and-status.test.js   # RED: 15 failed | 3 passed (18)
  - 1 test fixed: its first message took 450 ms, so the hook rightly widened the window; now 20 ms (as measured)
npx vitest run tests/unit/timing-and-status.test.js   # GREEN: 18 passed
npx vitest run                                        # 3 older expectations (blocked counted as "failed") updated to "blocked"
npx vitest run                                        # 755 passed
npm run lint && npm run build && npm run lint:firefox # clean, 0 errors / 0 warnings
```

## Known gaps

- Not run against real WhatsApp. With today's WhatsApp (2-26 ms) the windows stay at their old
  values; they only grow if WhatsApp gets slower.
- "Can't read the chat list" needs 3 minutes of failed checks before it shows.
