# TDD evidence: chats that share a name

**Why:** owner's request: two groups (or a group and a person) with the same name must be separate,
each with its own sound. Settings used to merge everything with one name into one row.

## What was built

| Part | What it does |
| ---- | ------------ |
| `view-model.mjs` `buildChatRows` | One row per REAL chat: each group (by `@g.us` id or recognised by behaviour) and each person is its own row; a person's old phone-number id (`@c.us`) joins their newest id (same contact, migrated), so no repeats. Only when a name has several chats do rows show "· last message N minutes ago" (newest first) to tell them apart. A single chat looks exactly as before. |
| `chat-actions.mjs` `applyChoice` | A choice in one of several same-name rows changes that chat only. A sound set earlier for the NAME is first copied to the other chats as their own setting, then the name-wide rule is removed. |
| `formatAgo` | Moved to `view-model.mjs` (re-exported by `health-ui.mjs`). |

```text
npx vitest run tests/unit/same-name-chats.test.js   # RED: 12 failed | 2 passed (the 2 = no-regression guards)
npx vitest run tests/unit/same-name-chats.test.js   # GREEN: 14 passed
npx vitest run                                      # 737 passed (no existing test changed)
npm run lint && npm run build && npm run lint:firefox   # clean, 0 errors / 0 warnings
```

## Known gaps

- Focused mode (WhatsApp open on screen) still identifies a message by the chat's NAME in
  WhatsApp's list; with two chats of the same name it uses the one that last notified. Background
  messages carry the chat id and are always exact.
- Two chats are told apart in settings only by when they last messaged.
