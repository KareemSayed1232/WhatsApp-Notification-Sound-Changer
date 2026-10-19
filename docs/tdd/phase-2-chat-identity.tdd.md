# TDD evidence: fragility plan, Phase 2 (chat identity)

**Source plan:** the fragility audit in the session, items C1, C2, I1, S3. **Checkpoint commits:**
not made (the owner commits on request); this report stands in.

## User journeys

- As a user, I want group chats recognised (and labelled "Group" in settings, and their members
  collected for "person in a group" sounds) even if WhatsApp changes its group id format.
- As a user, I want to be told if WhatsApp's notifications stop naming the chat, instead of the
  extension quietly recording wrong chat names or moving my rules.
- As a user, I want to be told if WhatsApp stops writing "Sender: message" in group notifications.

## What was built

| Part | What it does |
| ---- | ------------ |
| `core/chat-identity.mjs` (new) | Per session: a chat is a **group** if its id says so OR its messages come from 2+ different senders (a "sender" equal to the chat's own name does not count). **Titles generic** when one title arrives for 3+ different chat ids. Counts group messages in a row with no "Sender:" part. Sender names stay in memory only. |
| `bridge.mjs` | Feeds every notification to it; a recognised group's chat entry carries `group: true`; senders are collected for recognised groups whatever their id; with generic titles it records no chat name, moves no rule and teaches the learners nothing (id-bound rules still play). Reports both conditions to the status line. |
| `state-store.mjs`, `background.mjs` | Store `group: true` on a recent chat; once a group, always a group. |
| `view-model.mjs` | Settings label a chat "Group" if it is known to be one, or has a `@g.us` id. |
| `health.mjs`, `health-ui.mjs`, `strings.mjs` | Statuses `titles-generic` and `sender-format` (5 in a row) with their own sentences; in diagnostics too. |

```text
npx vitest run tests/unit/chat-identity.test.js   # RED: import of chat-identity.mjs fails
npx vitest run tests/unit/chat-identity.test.js   # tracker only: 9 failed | 14 passed (wiring missing)
npx vitest run tests/unit/chat-identity.test.js   # GREEN: 23 passed
npx vitest run                                    # 1 existing expectation updated: a group's chat entry now has group: true
npx vitest run                                    # 723 passed
npm run lint && npm run build && npm run lint:firefox   # clean, 0 errors / 0 warnings
```

## Known gaps

- Not run against real WhatsApp. With today's WhatsApp nothing visible changes except that a group
  chat entry is stored with `group: true`.
- A group with only one active sender is recognised only by its id until a second person writes.
- "Titles generic" stays on for the rest of the session once seen (a page reload clears it).
