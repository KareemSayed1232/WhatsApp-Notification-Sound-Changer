# TDD evidence: sounds while WhatsApp is focused

**Why:** measured on Firefox 158 (Oct 2026): with WhatsApp focused, a new message raises no
notification and plays no sound, so there is nothing to replace (`[WANSC]` showed only the hook
check). The chat's unread counter still goes up (`<span data-testid="icon-unread-count"
aria-label="1 unread message">1</span>` inside the chat's row).

**Checkpoint commits:** not made (the owner commits only on request).

## User journey

As a user with WhatsApp focused in Firefox, when someone writes in a chat I am not looking at, I
want to hear that chat's sound (or my default sound), like I do when WhatsApp is in the background.

## Task report

| Part | Summary |
| ---- | ------- |
| `readUnreadCounts` (chat-list) | Each rendered chat's unread number (test id first, "N unread" label as fallback), whether it is muted; Archived/Locked entries excluded; a number-less "marked unread" dot counts as 0. |
| `decideForChatName` (matcher) | The chat's decision from its name alone; id-bound chat rules match by name; sender rules never do. |
| `startUnreadWatcher` (new) | First look is a baseline; reports a chat whose counter rises (or that appears with unread) only while the tab is focused; skips muted chats, counters going down, and changes within 1 s of scrolling or searching the chat list. |
| `bridge.onIncomingChat` | Waits 700 ms; if WhatsApp raised a notification or played its own sound within 2 s, does nothing (already handled, e.g. Edge/Chrome); otherwise plays the chat's sound, or nothing if the decision is "WhatsApp's own"/silent; blocked audio is reported, never forced. |

```text
npx vitest run tests/unit/focused-sounds.test.js   # RED: import of unread-watcher.mjs fails (no tests run)
npx vitest run tests/unit/focused-sounds.test.js   # GREEN: 34 passed (34)
npm run test:coverage                              # 638 passed; All files 95.72 % statements
npm run lint && npx prettier --check . && npm run build && npm run lint:firefox   # clean, 0/0
```

## Known gaps

- Muted chats: the first version guessed a `muted` icon and was wrong (a muted chat still rang while
  focused, reported by the owner). The real marker, captured from a muted chat, is
  `data-testid="mute-notifications-refreshed"` with `aria-label="Muted chat"`. The test helper now
  uses that markup: RED 2 failed | 32 passed, GREEN 34 passed; full suite 638 passed.
- Not yet checked on real WhatsApp. A chat whose new message arrives while it is far down an
  un-rendered part of the list is caught when it jumps to the top (it is then new on screen).
- When Edge/Chrome do play WhatsApp's sound while focused, that path still uses the default sound,
  not the chat's own (it has no chat id); this watcher stays quiet there to avoid a double sound.
