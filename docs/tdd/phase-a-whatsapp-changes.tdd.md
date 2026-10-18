# TDD evidence: Phase A, "when WhatsApp changes"

**Source plan:** the dependency audit and fix plan in the session (Phase A only, the changes that
would silently stop per-chat sounds without the status line noticing). No `*.plan.md` file.

**Checkpoint commits:** not made. The project rule is to commit only when the owner asks, and the
previous update-proofing work was still uncommitted. This report stands in for the RED/GREEN
checkpoints.

## User journeys

- A1. As a user with browser notifications blocked, I want per-chat sounds to keep working even if
  WhatsApp starts checking permission through `navigator.permissions`.
- A2. As a user with per-chat sounds, I want my rules to keep working if WhatsApp gives my contacts
  a new kind of id (as it did moving from `@c.us` to `@lid`).
- A3. As a user, I want the status line to tell me if WhatsApp stops saying which chat a message is
  from, instead of claiming everything works.
- A4. As a user, I want to still hear the chat's sound if WhatsApp stops playing its own sound.

## Task report

| Task | Summary | RED | GREEN |
| ---- | ------- | --- | ----- |
| A1 | Hook answers `permissions.query({name:"notifications"})` with a "granted" status while popups are hidden; everything else goes to the browser; restored on uninstall. | 2 of 7 failed (`expected 'denied' to be 'granted'`) | 7/7 pass |
| A2 | `findRule` matches a chat rule by name when the notification's id is of a different kind; new `findRebind`; bridge sends `MSG_REBIND`; background validates and saves the new id. | 8 of 11 failed (`findRebind is not a function`, `expected { action: 'native' }`) | 11/11 pass |
| A3 | Hook marks no-notification sounds heard while the tab is in the background; health counts them (`unnamedRun`); 3 in a row gives status `no-chat-info` with its own sentence. | 5 of 8 failed (`expected ... to match object { background: true }`) | 8/8 pass |
| A4 | A notification not marked silent (so the OS would have rung) with a "play" decision gets the chat's sound played by us after 150 ms if WhatsApp plays none; a late WhatsApp sound is then suppressed, not doubled; counted as working. | 3 of 8 failed | 8/8 pass |

Commands actually run:

```text
npx vitest run tests/unit/whatsapp-changes.test.js   # RED:   18 failed | 16 passed (34)
npx vitest run tests/unit/whatsapp-changes.test.js   # GREEN: 34 passed (34)
npx vitest run                                       # first: 5 failed | 557 passed (562)
npx vitest run                                       # after test fix: 562 passed (562)
npm run test:coverage                                # All files 95.8 % statements, 93.9 % branches
npm run lint && npx prettier --check . && npm run build && npm run lint:firefox   # clean, 0/0
```

The 5 failures in the first full run were older tests whose fake notifications omitted
`silent: true`, which real WhatsApp always sends (measured Oct 2026). Under the new A4 rule such a
notification means "the OS was meant to ring", so the extension played the sound itself. The fakes
were corrected to send `silent: true` like WhatsApp (helper `whatsappNotifies`); no production code
was changed to make them pass.

## What the passing tests guarantee

| # | Guarantee | Test |
| - | --------- | ---- |
| 1 | `permissions.query` for notifications says "granted" only while spoofing, without asking the browser | `whatsapp-changes.test.js` A1 |
| 2 | Other permissions, odd arguments, and the no-bridge case all go to the browser | A1 |
| 3 | Uninstall restores the browser's `query`; missing `navigator.permissions` is fine | A1 |
| 4 | A rule bound to `@c.us` still plays for the same name arriving as `@lid`, and is re-saved with the new id | A2 matching, bridge, background |
| 5 | A rule never moves between two ids of the same kind (two people with the same name) | A2 matching |
| 6 | Exact id match wins and never triggers a rebind; disabled or id-less rules never rebind | A2 matching |
| 7 | The background ignores rebinds from untrusted senders and malformed ids, and survives a deleted rule | A2 background |
| 8 | Sounds without a notification are flagged only when the tab is hidden or unfocused | A3 hook |
| 9 | 3 such sounds in a row show "WhatsApp isn't saying which chat"; a notification or paired sound clears it | A3 status |
| 10 | The chat's sound plays once, after 150 ms, when WhatsApp plays none for a non-silent notification | A4 |
| 11 | No self-play for silent-marked notifications, silent/native decisions, or when WhatsApp's sound comes in time | A4 |
| 12 | A late WhatsApp sound after a self-play is suppressed (no double sound) and no "silent" is reported | A4 |

## Known gaps

- None of this has run against real WhatsApp: these are models of changes WhatsApp has not made
  (yet). Today's real-page behaviour is unchanged and still covered by the existing tests.
- A2 can still wrongly move a rule if two different people share a display name AND one of them is
  the first to appear under a new kind of id. Accepted trade-off, as planned.
- A4 cannot help when the decision is "WhatsApp's own sound" (native) and WhatsApp relies on the OS
  sound: the hidden popup takes the OS sound with it. The status line reports "no sound" then.
