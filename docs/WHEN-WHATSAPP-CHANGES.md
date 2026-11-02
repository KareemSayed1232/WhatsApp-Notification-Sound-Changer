# When WhatsApp changes

WhatsApp Web is not an API. It changes without notice, and this extension reaches into it. This page
lists exactly what we rely on, what happens when WhatsApp moves it, and how to find out fast when
something breaks. The full audit (browsers, stores, this project) is in
[WEAK-POINTS.md](WEAK-POINTS.md).

## What we depend on

Sounds are decided **only** from what WhatsApp itself does. Nothing on WhatsApp's page (chat list,
badges, icons) decides a sound.

| Dependency                                                                  | If WhatsApp changes it                                                                                                                                       | Where                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| It raises `new Notification(title, {tag: chatId})` from the page            | Without it no chat is named: only your default sound can play (status "no-chat-info"). `registration.showNotification()` from the page is handled the same.   | `main-hook.mjs`, `bridge.mjs`           |
| `tag` is the chat's unique id (`…@lid`, `…@g.us`)                           | Rules tied to an id stop matching. Rules made by name still match the exact title until they bind.                                                            | `matcher.mjs`                           |
| `title` is the chat's name                                                  | Only used to bind a name-made rule once. A title shared by 3+ chats is treated as generic and never binds (status "titles-generic").                          | `bridge.mjs` (`isGenericTitle`)         |
| It plays its message sound with `Audio.play()` a few ms after the notification | The sound is recognised by host and type, or as a detached element right after a notification. Late sounds (up to 3 s) still pair once. Status "no-sound".  | `main-hook.mjs` (`decideForElement`)    |
| The sound file name (`BS_BUUXbKq5.mp3`)                                     | Only needed while WhatsApp is focused (no notification). A file that follows a notification twice is learned, so a rename heals itself.                       | `main-hook.mjs` (`learn`), `protocol.mjs` |
| Web Audio instead of an `<audio>` element                                   | Watched only after notifications repeatedly come with no `<audio>` sound. **Not verified against real WhatsApp.**                                             | `main-hook.mjs` (`wrappedStart`)        |
| WhatsApp's page allowing `blob:` audio (its content security policy)        | Your sounds can't play in the page: WhatsApp's own ding plays instead. Checked on real WhatsApp, Nov 2026.                                                    | `main-hook.mjs` (`playOwn`)             |
| The chat list markup (`#pane-side`, rows, `span[title]`)                    | Only **Refresh chat list** stops (display). Sounds are unaffected.                                                                                           | `chat-list.mjs`                         |
| Notifications from WhatsApp's service worker (push, tab closed)             | **Cannot be intercepted**: they never pass through the page.                                                                                                 | n/a                                     |

Everything fails **open**: if anything unexpected happens inside the hook, WhatsApp behaves exactly as
if the extension were not installed.

## How a break is noticed

The popup shows a status line, and the settings page has an "Is it working?" card:

| Status                                         | Meaning                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Working. Last handled a message _N_ ago        | WhatsApp's sound was handled.                                                                                 |
| Waiting for a message                          | Nothing has happened yet.                                                                                     |
| WhatsApp plays sounds but sends no notifications | WhatsApp's own notifications are off (or WhatsApp stopped raising them): only the default sound can play.   |
| WhatsApp keeps notifying us but plays no sound | 3+ notifications in a row with no sound after them: WhatsApp changed, or its own sounds are off.              |
| Can't reach the WhatsApp page                  | The page hook is not answering (reload the WhatsApp tab).                                                     |
| WhatsApp replaced something we rely on         | WhatsApp overwrote `Notification` or `play()` and locked it (an ordinary replacement is undone every 30 s).   |

## Diagnosing a break

1. Settings → Troubleshooting → **Run a self-test** in the WhatsApp tab: page hook, enabled, chat
   list, sounds handed to the page.
2. **Copy diagnostics**: version, browser, counts and the _shape_ of what WhatsApp did (kind of chat
   id, sound host and type). No names, ids or messages.
3. For detail, in the WhatsApp tab console run `localStorage.wanscDebug = "1"`, reload, and read the
   `[WANSC]` lines: each notification, WhatsApp's sound, and the decision (`ruleId: null` means no
   rule matched, so the default sound or WhatsApp's own played).
4. Compare with the table above:
   - `notifications` rising but `soundsHandled` flat: the sound is no longer recognised
     (`whatsappShapes.sound`).
   - `backgroundSoundsWithoutChatInARow` rising: WhatsApp's notifications are off or gone.
   - hook `missing` or `overwritten`: the hook could not install, or WhatsApp replaced it.

## Fixing it

- A new sound host or type: widen `SOUND_HOST` / `SOUND_FILE` in `src/core/protocol.mjs`.
- A new sound route: add a wrapper in `installMainHook`, following `wrappedStart`, with a scenario in
  `tests/unit/main-hook-resilience.test.js`.
- A new chat-list structure (Refresh chat list only): **Copy page layout**, add it to
  `tests/fixtures/whatsapp-chat-list.html`, and fix `src/content/chat-list.mjs`.

Every change starts as a failing test that models what WhatsApp now does, so the same break cannot
come back unnoticed.
