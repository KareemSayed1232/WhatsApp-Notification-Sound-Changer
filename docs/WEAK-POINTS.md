# Weak points: everything 3.0 depends on

> **Current design (supersedes the sections below about the chat list, mutes, the backup and the
> sound gate):** sounds are decided only from WhatsApp's own notification (chat id) and its own
> message sound. Nothing on WhatsApp's page decides a sound. The page is read only for "Refresh
> chat list" (display). What remains to depend on: WhatsApp raising notifications from the page,
> `tag` being the chat id, and WhatsApp playing its message sound through `play()`. If any of
> these changes, the extension steps back and WhatsApp behaves as without it.

A pre-release audit (29 October 2026, version 3.0.0) of what could break, how soon, what the user
would see, and what's already in place. How to diagnose and fix a WhatsApp change is in
[WHEN-WHATSAPP-CHANGES.md](WHEN-WHATSAPP-CHANGES.md).

**Likelihood:** **High** = expect it within months. **Medium** = some time in a year or two.
**Low** = unlikely, but it would hurt.

## 1. WhatsApp Web (changes without notice, often weekly)

| #   | Depends on                                                                                     | Likely | If it changes                                                                                                  | Already in place                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | WhatsApp calls `new Notification(title, {tag})` from the **page** while the tab is open | Medium | It was the biggest risk: if WhatsApp moved to service-worker push for open tabs too, background sounds would stop. | **3.0: the chat list backs it up.** Once WhatsApp has said nothing about 3 background messages from 2+ chats (one quiet chat is just a muted one), a chat whose unread counter rises gets its sound from the list, about 2.5 s later, unless it is muted. Any notification turns this off again. WhatsApp's own push pop-up and sound would still appear, and that part can't be stopped. |
| W2  | The notification **title is the chat name** and the **tag is the chat id** (`…@lid`, `…@g.us`)  | Medium | Rules by name or id stop matching.                                                                              | Tag first, name second. "titles-generic" and "no-chat-info" statuses. Chat-identity learns the id kinds.                                     |
| W3  | Group bodies look like `Sender: text`                                                          | Medium | Per-person-in-group sounds stop. Chat sounds still work.                                                       | "sender-format" status after 5 misses.                                                                                                       |
| W4  | WhatsApp plays its sound with `Audio.play()` (or Web Audio) soon after the notification | Low | Our sound plays **and** WhatsApp's too, or ours never replaces it. | Adaptive pairing window (0.5–2 s). **3.0: a known WhatsApp sound up to 3 s after a notification no sound has claimed still gets that chat's sound, once.** Web Audio wrapper, self-play, learned sound files, "no-sound" status. |
| W5  | The sound file is on `*.whatsapp.net` / `.com` with an audio extension                         | Low    | The sound isn't recognised while focused.                                                                      | Files that follow a notification are learned. Host and type live in one place (`protocol.mjs`).                                              |
| W6  | WhatsApp reads `Notification.permission` and `permissions.query` to decide whether to notify    | Low    | With pop-ups hidden, WhatsApp may stop notifying → like W1.                                                    | Both are answered. Turning on "Show pop-ups" uses the real permission as a fallback.                                                         |
| W7  | The **chat list markup** (`#pane-side`, rows, title spans, unread counter, mute icon) | High | "Refresh chat list", focused-tab sounds, mute markers and the W1 backup stop. Background sounds still work while WhatsApp notifies. | Self-teaching page model (learned → built-in → structure → labels), contract tests with 9 variants, "list-unreadable" status, learned mutes. **3.0: "Copy page layout" gives an anonymised copy to turn into a new test case.** |
| W8  | The address `https://web.whatsapp.com`                                                         | Low    | Nothing runs.                                                                                                  | One constant plus the manifest. A test keeps them in sync. Needs a new release (new permission).                                             |
| W9  | WhatsApp replacing `Notification` / `play()` after we wrap them | Low | Sounds would stop until reload. | **3.0: checked every 30 s, and the hook puts itself back on top**, keeping the replacement working underneath. "hook-overwritten" only if the page locks the property. |

### Timing between our own parts (fixed in 3.0)

The hook, the chat list and the held focused-tab sound are separate ways to notice one message.
Up to 3.0 they were linked by time ("anything within ±2 s"). In a background Edge tab the chat
list is read late, so a notified message looked unnotified: it played a second sound and taught
the mute learner a false mute. Now:

- messages are matched to notifications **by chat** (`message-ledger.mjs`, ±15 s);
- **every** sound goes through one gate (`sound-gate.mjs`): one per chat per message (4 s), never
  two within 1 s, never one more than 3 s late (frozen tab), and a sound that only finishes
  loading after 3 s is not started;
- after one of our own sounds, the hook keeps WhatsApp's own incoming sound quiet for 1.5 s;
- the mute learner needs **two** quiet messages in a row for the same chat.

Diagnostics count what the gate did: `secondSoundsStopped` and `lateSoundsDropped`.

### Guesses about WhatsApp's page (audited after the "badge read as a name" bug)

The extension often guesses what something on WhatsApp's page is. The dangerous ones are guesses
that are **saved and reused**: one wrong guess then keeps repeating. Every guess, and its guard:

| Guess                                                     | Saved?                          | Guard                                                                                                                    |
| --------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A chat row's **name**                                     | yes (known chats)               | Never a count, "N unread messages", time or date, nor the unread badge; never the preview. Stored badge "names" ignored. |
| Where the name / counter sit (**learned fingerprints**)   | yes                             | Two agreeing notifications to learn; every read re-checks the element (a badge or count is refused).                     |
| A chat row's **unread count**                             | no                              | Only digits; a "marked as unread" dot counts 0; the structural guess must come after the row's last titled text.         |
| A **mute icon**                                           | no                              | Any icon named "*mute*" but not "*unmute*"; once icons are seen on the page, no icon = not muted.                        |
| A chat is **muted** (learned from behaviour)              | yes (versioned)                 | Two quiet messages in a row for that chat, matched by chat with a 15 s window; mutes saved by the old rule dropped.      |
| **WhatsApp's incoming sound** (learned files)             | yes (versioned)                 | Must follow a notification twice ("message sent" after a quick reply is not learned); old one-time files dropped.         |
| A **rule's chat moved** to a new id (WhatsApp id change)  | yes (rewrites the rule)         | Only after the new id is seen twice and the old id not at all this session (two people with one name keep their rules).  |
| Which **notification** a sound / list message belongs to  | no                              | Matched by chat (ledger), one sound per message (gate).                                                                  |
| A notification **title is a chat name**                   | via known chats                 | Generic titles detected and then nothing is learned from them.                                                           |
| A group message's **sender** ("Name: text")               | via recent senders              | Only for groups (or ids not known to be one-to-one); a colon in a URL or time does not count.                            |
| **Archived / Locked chats** entries                       | no                              | Buttons outside list rows (any language), then the English label.                                                        |

Each row has tests in `tests/unit/no-sticky-guesses.test.js`, `badge-not-a-name.test.js`,
`focused-silence.test.js`, `one-sound.test.js` and `markup-contract.test.js`.

## 2. Browsers (each major update)

| #   | Depends on                                                  | Likely | If it changes                                           | Already in place                                                                               |
| --- | ----------------------------------------------------------- | ------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| B1  | Page-world content scripts (`"world": "MAIN"`)               | Low    | Nothing can be intercepted.                             | Chrome 111+ / Firefox 128+ minimums. "hook-missing" status.                                    |
| B2  | **Autoplay rules**: Firefox needs a click before page audio   | High   | Silence until the user clicks (already the case today). | 3.0: "click once" status plus an **Open WhatsApp** button. Falls back to WhatsApp's own ding.  |
| B3  | Chrome treating a rarely-used site's audio as blocked         | Medium | Same as B2 on Chromium.                                 | Same detection. The banner shows on any browser.                                               |
| B4  | MV3 service worker / Firefox event page lifetime              | Low    | Sounds fetched slowly, or popup lag.                    | Sounds are cached in the tab after first use.                                                  |
| B5  | Firefox's `data_collection_permissions` requirement           | Medium | AMO refuses new uploads if the key's format changes.    | Declared `none`. `web-ext lint` runs in CI.                                                    |
| B6  | Android pausing background tabs                               | High   | No sound with Firefox in the background on a phone.     | Documented. Android labelled experimental.                                                     |

## 3. Stores and policy

| #   | Risk                                                                    | Likely | Mitigation                                                                                                              |
| --- | ----------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| S1  | Reviewers reading the reported "granted" permission as deceptive         | Medium | Written justification in [STORES.md](STORES.md). Pop-ups can be turned back on. The real permission is never changed.   |
| S2  | Trademark: "WhatsApp" in the name, icon or screenshots                   | Medium | "… for WhatsApp" naming, our own bell icon, "not affiliated" in the listing, app and README. Blurred screenshots.       |
| S3  | AMO source review (bundled code)                                         | Low    | No minifier. Source zip plus `npm ci && npm run build`.                                                                 |
| S4  | Losing the Firefox add-on id                                             | Low    | Fixed in `scripts/build.mjs`. Never change it.                                                                          |
| S5  | Chrome users on manual install never get fixes                           | High   | Release notes on GitHub. Consider the Chrome Web Store once the $5 fee is affordable.                                   |

## 4. This project

| #   | Weak point                                                                | Mitigation                                                                                                                                  |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **One tester** (owner, Windows, Edge + Firefox)                            | Unlisted beta first. [PENDING-CHECKS.md](PENDING-CHECKS.md) before every release.                                                           |
| P2  | Android never run on a device                                              | Labelled experimental. The checklist is in PENDING-CHECKS.                                                                                  |
| P3  | Nothing checks real WhatsApp automatically (it needs a logged-in account) | **3.0: Settings → Troubleshooting → Run a self-test** checks the hook, chat list, counters and sound inside your WhatsApp tab. Run it in Edge and Firefox before each release. |
| P4  | CI used to run only on `main` and pull requests | **3.0: CI runs on every pushed branch.** |
| P5  | Uploaded sounds live in extension storage only                              | Removing the extension deletes them, and there's no backup (settings export is planned for 3.1).                                            |
| P6  | Build toolchain (esbuild, web-ext, vitest, Node 20+) major updates          | `package-lock.json` pins versions, and CI tests Node 20 and 22. Update deliberately.                                                       |
| P7  | English-only UI                                                             | All text is in `src/ui/strings.mjs`. Arabic is planned for 3.1.                                                                             |

## Can't be fixed by any extension

- Notifications while the tab or browser is closed (WhatsApp's service-worker push), and the
  WhatsApp desktop app.
- WhatsApp turning off its own notifications or sounds in its settings (the status line says
  "plays no sound").
- A browser that never allows page audio (the user must allow autoplay for web.whatsapp.com).

## What to watch after release

1. GitHub issues, especially diagnostics showing `status` other than `working`.
2. Your own status line, every day, in both Edge and Firefox.
3. After a WhatsApp redesign, press **Refresh chat list** and copy the diagnostics. If `chatList` says
   `label` or `none`, re-capture the list into `tests/fixtures/whatsapp-chat-list.html`.
