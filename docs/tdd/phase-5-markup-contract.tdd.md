# TDD evidence: fragility plan, Phase 5 (markup contract library)

**Source plan:** the fragility audit in the session, plan items 15-16.

## What was built

- `tests/fixtures/whatsapp-chat-list.html`: WhatsApp's chat list rebuilt from the owner's real
  captures (Edge 155 / Firefox 158, Oct 2026), names changed: list, rows, names, times, previews,
  unread counters, a muted marker, the "Archived" and "Locked chats" entries, and the open chat's
  header also showing a chat name.
- `tests/unit/markup-contract.test.js`: 9 variants standing in for WhatsApp updates (today's;
  test ids removed; roles removed; ids removed; labels removed; everything renamed; labels in
  Arabic; rows wrapped deeper; all removals at once). Each must give the same chats in the same
  order with the same unread numbers, no Archived / Locked rows, a findable list, the same chats
  from "Refresh chats", and a focused-mode new message noticed. The muted marker must be found
  whenever any trace of it survives (otherwise the behaviour-learned mutes take over).
- A **control**: the original names-only reader finds **no chats** on "all of it at once" and
  "everything renamed", so the contract does test something real.

```text
npx vitest run tests/unit/markup-contract.test.js   # 56 passed on first run (Phases 1-3 built what it checks)
  + control tests                                   # 1 failed: wrong expectation ("ids removed" - the old reader had fallbacks); removed
npx vitest run tests/unit/markup-contract.test.js   # 59 passed
npx vitest run                                      # 818 passed
npm run lint && npm run build && npm run lint:firefox   # clean, 0 errors / 0 warnings
```

No production code changed in this phase: every variant already passed.

## Known gaps

- If WhatsApp ALSO moves the unread counter before the message preview AND removes every name and
  label, the counter is not found by structure (a learned fingerprint cannot be learned then
  either). Focused-mode sounds would stop; background sounds are unaffected; the status line
  would not warn (names are still read). Kept strict on purpose: relaxing it would mistake
  digit-only times or previews for counters.
- The fixture is one snapshot; add new captures as variants when WhatsApp changes.
