# TDD evidence: Phase B, "when WhatsApp changes"

**Source plan:** the dependency audit and fix plan in the session, Phase B (items 5 to 9): never
silent by accident, and tolerance for small changes. No `*.plan.md` file.

**Checkpoint commits:** not made (the owner commits only on request). This report stands in for
the RED/GREEN checkpoints.

## User journeys

- B5. As a user, if the browser is still blocking sound (I have not clicked in WhatsApp yet), I want
  to hear WhatsApp's own sound rather than silence, and be told why my sound did not play.
- B6. As a user, I want sounds to keep working if WhatsApp starts waiting for the notification's
  "show" or "close" events.
- B7. As a user with WhatsApp in Arabic (or any language), I do not want "Archived" or "Locked chats"
  listed as chats.
- B8. As a user with group "person" rules, I want them to keep working if WhatsApp slightly changes
  how it writes "Sender: message", or changes its group ids.
- B9. As the maintainer, I want WhatsApp's address in one place, checked against the manifest.

## Task report

| Task | Summary | RED | GREEN |
| ---- | ------- | --- | ----- |
| B5 | `engine.canPlay()`; the bridge turns a "play" decision into WhatsApp's own sound when audio cannot start; play results feed a `failedRun` counter and a "play-failed" status with its own sentence. Audio is requested when WhatsApp loads. | 8 of 14 failed (`canPlay is not a function`, `expected { action: 'play' } to equal { action: 'native' }`) | 14/14 |
| B6 | The hidden notification fires `show` (asynchronously) and `close` (once), keeps real listener lists, and isolates throwing handlers. | 4 of 5 failed | 5/5 |
| B7 | Non-chat rows recognised by structure: a button outside any list row. | 2 of 4 failed (Arabic and other-language labels listed as chats) | 4/4 |
| B8 | Sender separator accepts any space after the colon (incl. no-break spaces) and the full-width colon; senders are collected for every chat-id kind except known one-to-one kinds, never when equal to the chat name. | 5 of 16 failed | 16/16 |
| B9 | `WHATSAPP_ORIGIN` / `WHATSAPP_MATCH` in `protocol.mjs`, used by background and chat actions; a test checks the manifest and that no other module writes the address. | 3 of 3 failed | 3/3 |

Commands actually run:

```text
npx vitest run tests/unit/whatsapp-changes-b.test.js   # RED:   22 failed | 20 passed (42)
npx vitest run tests/unit/whatsapp-changes-b.test.js   # first GREEN run: 2 failed | 40 passed
npx vitest run tests/unit/whatsapp-changes-b.test.js   # GREEN: 42 passed (42)
npx vitest run                                         # 604 passed (604)
npm run test:coverage                                  # All files 95.86 % statements, 93.98 % branches
npm run lint && npx prettier --check . && npm run build && npm run lint:firefox   # clean, 0/0
```

The 2 failures in the first GREEN run were a harness gap: the test bridge had no page hook, so the
status correctly said "hook missing", which outranks "play failed". The harness now answers the
bridge's ping like an installed hook; the assertions are unchanged.

## What the passing tests guarantee

| # | Guarantee | Test |
| - | --------- | ---- |
| 1 | `canPlay()` is true only when audio is running, false (and asks to resume) while suspended, false if audio cannot be created | B5 engine |
| 2 | A "play" decision becomes WhatsApp's own sound when audio cannot start, for chats and for the default sound | B5 bridge |
| 3 | Silent rules stay silent; an engine without `canPlay` behaves as before | B5 bridge |
| 4 | A fallback or a failed playback shows "Your sound couldn't play…"; the next successful sound clears it; a missing hook still outranks it | B5 bridge, status |
| 5 | The hidden notification fires `show` once, never synchronously, and `close` once | B6 |
| 6 | Removed listeners are not called; a throwing handler does not stop the others; manual `dispatchEvent` works | B6 |
| 7 | "Archived"/"Locked chats" in Arabic, Spanish or German are not listed; real chats named "Archived photos" are | B7 |
| 8 | A chat row wrapped in a button inside a row is still a chat | B7 |
| 9 | Sender found with `: `, `:` + no-break space, ` :`, and full-width `：`; never in "12:30", URLs or text with no colon | B8 |
| 10 | Senders collected from groups and unknown id kinds, never from `@lid` / `@c.us` chats or when equal to the chat name | B8 |
| 11 | The address is defined once and the manifest uses exactly it | B9 |

## Known gaps

- B5 trade-off: right after WhatsApp loads and before any click in the tab, the browser may still
  block audio; that first message then plays WhatsApp's own sound instead of yours (previously it
  could be silent). Audio is requested at load, so this is usually avoided.
- B7 relies on one captured snapshot of WhatsApp's markup (Oct 2026). Not checked against a live
  Arabic-language WhatsApp.
- None of this has run against real WhatsApp yet.
