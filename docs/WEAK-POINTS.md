# Weak points: everything 3.0 depends on

A pre-release audit (2 November 2026, version 3.0.0) of what could break, how soon, what the user
would see, and what's in place. How to diagnose a WhatsApp change is in
[WHEN-WHATSAPP-CHANGES.md](WHEN-WHATSAPP-CHANGES.md).

**The design in one paragraph.** Sounds are decided only from what WhatsApp itself does: its
notification (the `tag` names the chat by its unique id) and its message sound. A notification
picks that chat's rule; WhatsApp's sound with no notification (WhatsApp focused) gets your default
sound, else WhatsApp's own; when WhatsApp makes no sound, neither does the extension. Nothing on
WhatsApp's page decides a sound. Your sounds are handed to the WhatsApp page in advance and played
there; if one is missing, WhatsApp's own ding plays.

**Likelihood:** **High** = expect it within months. **Medium** = some time in a year or two.
**Low** = unlikely, but it would hurt.

## 1. WhatsApp Web (changes without notice)

| #   | Depends on                                                           | Likely | If it changes                                                       | In place                                                                   |
| --- | -------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| W1  | WhatsApp raises `new Notification()` from the page while the tab is open | Medium | No chat is named: only the default sound plays.                     | "no-chat-info" status. `showNotification()` from the page is also wrapped. |
| W2  | The notification `tag` is the chat id                                 | Medium | Rules tied to ids stop matching.                                    | Tag kinds in diagnostics. Name rules still match the title.                |
| W3  | WhatsApp plays its sound with `Audio.play()` soon after the notification | Low    | Ours doesn't replace WhatsApp's, or both play.                      | Adaptive pairing (0.5–2 s), late pairing up to 3 s, "no-sound" status.     |
| W4  | The sound file name / host                                            | Low    | Not recognised while focused.                                       | A file that follows a notification twice is learned.                       |
| W5  | WhatsApp's page allowing `blob:` audio                                | Low    | Your sounds can't play: WhatsApp's ding plays.                      | Checked on real WhatsApp (Nov 2026). Falls back to WhatsApp's own sound.   |
| W6  | WhatsApp reading `Notification.permission` / `permissions.query`      | Low    | With pop-ups hidden, WhatsApp may stop notifying (like W1).         | Both answered. "Show pop-ups" uses the real permission.                    |
| W7  | WhatsApp replacing `Notification` / `play()` after we wrap them       | Low    | Sounds stop until reload.                                           | Checked every 30 s; the hook puts itself back on top.                      |
| W8  | The chat list markup                                                  | High   | Only **Refresh chat list** stops. Sounds are unaffected.            | Fallback selectors, "Copy page layout" for a new test case.                |
| W9  | The address `https://web.whatsapp.com`                                | Low    | Nothing runs.                                                       | One constant plus the manifest, kept in step by a test.                    |

## 2. Open findings from the code review (2 November 2026)

**Fixed** before release (2 November 2026, each with a test), or to fix soon after release (**L**).

| #   | Finding                                                                                                                                                                                                      | When |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| F1  | The hook sends the notification's **message text** (`body`) to the bridge, which never uses it. The store reviewer notes say message text never leaves the page script.                                     | Fixed |
| F2  | One failed play sets the "Your sound failed" status **for good**: nothing resets it any more (the signal that did came from the removed audio engine).                                                      | Fixed |
| F3  | A sound that fails **after** it starts (browser blocks audio, file can't be decoded) is silence: no fallback to WhatsApp's ding and no status.                                                              | Fixed |
| F4  | Every notification updates "recent chats", which makes the bridge fetch **every sound again** (up to 2 MB each) and replace the page's copies, possibly cutting off one that is starting.                    | Fixed |
| F5  | Two chats notifying within the pairing window: the first message gets the second chat's sound, the second gets the default (one waiting slot, not a queue).                                                  | L    |
| F6  | Events on WhatsApp's page are not authenticated: any script in that page can ask questions, hand sounds, or fake a notification that records a chat name or ties a name-made rule to the wrong id.          | L    |
| F7  | At page load, a notification raised before the bridge has read your settings passes through unmanaged.                                                                                                       | L    |
| F8  | A name-made rule binds to the first chat that notifies with that title. A name rule and an id rule for one chat can coexist; the name rule then shows "Waiting for first message" forever.                    | L    |
| F9  | A failed bind (e.g. that id already has a rule) is silently retried on every notification and never reported.                                                                                               | L    |
| F10 | Uploads are checked by the browser's file type and size only; a file that can't be decoded is accepted (and then hits F3).                                                                                   | L    |
| F11 | A choice in the UI is several separate store writes; a failure midway leaves the chat half changed.                                                                                                          | L    |
| F12 | Leftovers from removed features: the "quiet" event (any page script can mute WhatsApp's ding for 3 s), `sender` rules still accepted by the schema, the "people in groups" rows, and statuses and counters that can no longer fire. | Fixed |
| F13 | `showNotification` is not put back by the self-healing check (only `Notification` and `play()` are).                                                                                                        | L    |
| F14 | Two WhatsApp tabs writing the status record at once can lose counts (read-modify-write).                                                                                                                     | L    |

## 3. Browsers (each major update)

| #   | Depends on                                            | Likely | If it changes                                           | In place                                              |
| --- | ----------------------------------------------------- | ------ | ------------------------------------------------------- | ----------------------------------------------------- |
| B1  | Page-world content scripts (`"world": "MAIN"`)         | Low    | Nothing can be intercepted.                             | Chrome 111+ / Firefox 140+ minimums. "hook-missing".  |
| B2  | Autoplay rules: Firefox needs a click before page audio | High   | Silence until the user clicks.                          | "play-blocked" status with an Open WhatsApp button.   |
| B3  | MV3 service worker / Firefox event page lifetime        | Low    | Sounds handed to the page slowly.                       | Sounds are handed over in advance, not per message.   |
| B4  | Firefox's `data_collection_permissions` key             | Medium | AMO refuses uploads if the format changes.              | Declared `none`. `web-ext lint` in CI.                |
| B5  | Android pausing background tabs                         | High   | No sound with Firefox in the background on a phone.     | Documented. Android labelled experimental.            |

## 4. Stores and policy

| #   | Risk                                                            | Likely | Mitigation                                                                                                     |
| --- | --------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| S1  | Reviewers reading the reported "granted" permission as deceptive | Medium | Justification in [STORES.md](STORES.md). Pop-ups can be turned back on. The real permission is never changed.  |
| S2  | Trademark: "WhatsApp" in the name, icon or screenshots           | Medium | "… for WhatsApp" naming, our own icon, "not affiliated" everywhere, blurred screenshots.                       |
| S3  | AMO source review (bundled code)                                 | Low    | No minifier. Source zip plus `npm ci && npm run build`.                                                        |
| S4  | Losing the Firefox add-on id                                     | Low    | Fixed in `scripts/build.mjs`. Never change it.                                                                 |
| S5  | Chrome users on manual install never get fixes                   | High   | Release notes on GitHub.                                                                                       |

## 5. This project

| #   | Weak point                                                     | Mitigation                                                                             |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| P1  | One tester (owner, Windows, Edge and Firefox)                   | Unlisted beta. [PENDING-CHECKS.md](PENDING-CHECKS.md) before every release.            |
| P2  | Android never run on a device                                   | Labelled experimental.                                                                 |
| P3  | Nothing checks real WhatsApp automatically (needs a logged-in account) | **Run a self-test** in Edge and Firefox before each release.                    |
| P4  | No end-to-end test in a real browser                            | Unit and integration tests in jsdom only.                                              |
| P5  | Uploaded sounds live in extension storage only                  | Removing the extension deletes them. Export/import is planned for 3.1.                 |
| P6  | Build toolchain updates                                         | `package-lock.json` pins versions; CI tests Node 20 and 22.                            |
| P7  | English-only UI                                                 | All text is in `src/ui/strings.mjs`. Arabic is planned for 3.1.                        |

## Can't be fixed by any extension

- Notifications while the tab or browser is closed (WhatsApp's service-worker push), and the
  WhatsApp desktop app.
- WhatsApp's own notifications or sounds turned off in its settings (the status line says so).
- A browser that never allows page audio.
