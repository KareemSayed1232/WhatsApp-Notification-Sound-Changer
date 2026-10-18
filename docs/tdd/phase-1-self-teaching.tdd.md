# TDD evidence: fragility plan, Phase 1 (self-teaching page reading)

**Source plan:** the fragility audit and fix plan in the session (items M1-M7, C5, S4). Phase 1
only. **Checkpoint commits:** not made (the owner commits on request); this report stands in.

## User journeys

- As a user, I want focused-mode sounds, Refresh chats and the chat list to keep working when
  WhatsApp renames the names in its page (ids, test ids, roles, English labels).
- As a user with WhatsApp in any language, I want none of this to depend on English words.
- As a user, I want muted chats to stay silent even if WhatsApp changes how it marks them.
- As a user with two chats of the same name, I want the right chat's sound.

## What was built

| Part | What it does |
| ---- | ------------ |
| `fingerprint.mjs` | What an element looks like (tag, WhatsApp test id, attribute names, depth in the row); never text, titles or labels. |
| `page-model.mjs` | Reads the chat list trying, in order: what was **learned** from notifications, WhatsApp's names of **today**, page **structure** (the element with the most children showing known chat names; counter = digits-only leaf after the preview; name = text equal to a known chat), **English labels last**. Learns name and counter fingerprints from notifications, trusted after 2 agreeing observations. |
| `mute-learner.mjs` | WhatsApp sends no notification for muted chats: a background counter rise with no notification within 2 s means muted; a notification means not muted. Learns nothing until at least one notification arrived. |
| `unread-watcher.mjs` | Reads through the model; reports every rise (`onRise`), uses learned mutes first. |
| `chat-list.mjs` / `chat-watcher.mjs` | Refresh and the name collector read through the model. |
| `bridge.mjs` | Hands each notification's name + id to the learners; lists known chat names; same-name chats prefer the id last notified. |
| `bridge.entry.mjs` | Wires it all; saves learning under `pageModel` in chrome.storage; learns mutes only while the tab is hidden. |

## Commands and evidence

```text
npx vitest run tests/unit/self-teaching.test.js   # RED: import of fingerprint.mjs fails (compile-time)
npx vitest run tests/unit/self-teaching.test.js   # 34 passed, 1 failed: test fixture shaped unlike the learned rows (fixed fixture)
npx vitest run tests/unit/self-teaching.test.js   # GREEN: 35 passed
  + 2 tests for Refresh / name collector:          # RED: 2 failed (options ignored) -> GREEN 37 passed
npx vitest run                                    # 1 existing assertion expected scan({document}) exactly; now objectContaining (scan also gets the reader)
npx vitest run                                    # 675 passed (675)
npm run test:coverage                             # All files 94.22 % statements
npm run lint && npm run build && npm run lint:firefox   # clean, 0 errors / 0 warnings
```

## What the tests guarantee

| # | Guarantee |
| - | --------- |
| 1 | Real WhatsApp markup reads exactly as before (names, counts, muted marker); no regression |
| 2 | With every id, test id, role and English label removed, names and counters are still read from known chat names |
| 3 | Unknown chats in that list are read too; the open chat's header does not fool it |
| 4 | Times and digit-only message previews are never taken for unread counts |
| 5 | A list found by structure needs at least two known chats on screen |
| 6 | Arabic names with no English anywhere work |
| 7 | Fingerprints contain no names, label text or counts; stored ones are validated |
| 8 | A learned fingerprint beats guesswork (decoy number test); one observation is not enough |
| 9 | Mutes: background rise + no notification -> muted; notification -> not muted; unmute noticed; no learning without notifications; only real changes reported |
| 10 | Learned mute beats the page marker both ways |
| 11 | Same-name chats: the id last notified wins |
| 12 | Refresh chats and the name collector work on the fully renamed page |

## Known gaps

- Not run against real WhatsApp yet. Real WhatsApp still uses today's names, so the new layers
  stay mostly idle until WhatsApp changes something.
- The structural list needs at least two chats the extension already knows on screen.
- Mute learning needs one background message per chat (after which it is saved).
