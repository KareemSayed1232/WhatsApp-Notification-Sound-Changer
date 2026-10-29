# When WhatsApp changes

WhatsApp Web is not an API. It changes without notice, and this extension reaches into it. This page
lists exactly what we rely on, how each piece copes when WhatsApp moves it, and how to find out fast
when something does break. Nothing here can promise that no update will ever break the extension; the
aim is that most changes are absorbed, and the rest are noticed in minutes and fixed in one place.

## What we depend on

| Dependency                                                                  | If WhatsApp changes it                                                                                                                                                                      | Where                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| It raises `new Notification(title, {tag: chatId})` for each message         | The chat is matched by `tag` first, then by title (name). If `tag` stops being a chat id, name rules still work. A service-worker `showNotification()` from the page is handled the same way. | `main-hook.mjs`, `matcher.mjs`            |
| It plays its message sound a few ms after the notification (`Audio.play()`) | The sound is recognised by what it does: an audio element that is not in the page, played within 500 ms of a notification. A new file name, host or file type is absorbed.                   | `main-hook.mjs` (`decideForElement`)      |
| The sound file name (`BS_BUUXbKq5.mp3`)                                     | Only needed when the tab is focused (no notification is raised then). A sound that follows a notification is **learned**, so a renamed file heals itself after the next background message. | `main-hook.mjs` (`learn`), `protocol.mjs` |
| Sound played through Web Audio instead of an `<audio>` element              | Watched only after notifications repeatedly arrive with no `<audio>` sound, or once it has been seen working. **Unverified against real WhatsApp**: a fallback for a change not yet seen.    | `main-hook.mjs` (`wrappedStart`)          |
| The chat list in the DOM (`#pane-side`, row roles, `data-testid`s)          | Several fallbacks for the container and the rows. If everything fails, the list stays empty and chats are still learned from messages as they arrive.                                       | `chat-list.mjs`                           |
| The unread counter on a chat row (`data-testid="icon-unread-count"`), used while WhatsApp is focused (Firefox raises no notification and plays no sound then) | Falls back to an "N unread" label. If neither is found, focused messages stay silent in Firefox (as before); background messages are unaffected. | `chat-list.mjs` (`readUnreadCounts`), `unread-watcher.mjs` |
| Notifications raised by WhatsApp's own service worker (from a push)         | **Cannot be intercepted**: they never pass through the page. If WhatsApp moves entirely to push notifications, this approach stops working for background tabs.                             | n/a                                       |

Everything fails **open**: if anything unexpected happens inside the hook, WhatsApp behaves exactly as
if the extension were not installed. A WhatsApp update can make the extension stop _helping_; it
should not make WhatsApp stop _working_.

## How a break is noticed

The popup shows a status line, and the settings page has an "Is it working?" card:

| Status                                         | Meaning                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Working. Last handled a message _N_ ago        | A notification was followed by a sound and we handled it.                                        |
| Waiting for a message                          | Nothing has happened yet.                                                                        |
| WhatsApp keeps notifying us but plays no sound | 3+ notifications in a row with no sound after them: WhatsApp changed, or its own sounds are off. |
| Can't reach the WhatsApp page                  | The page hook is not answering (WhatsApp tab needs a reload, or the hook cannot run).            |
| WhatsApp replaced something we rely on         | WhatsApp overwrote `Notification` or `play()` after we installed our wrappers.                   |

The hook is checked every 30 seconds with a ping, so a change that happens mid-session is caught too.

## Diagnosing a break

1. Settings -> "Is it working?" -> **Copy diagnostics**. It contains the extension version, browser,
   counts, and the _shape_ of what WhatsApp did (kind of chat id, sound host and file type, whether the
   sound element was detached). It contains **no** chat names, ids, messages, sound names or URLs.
2. For detail, in the WhatsApp tab console run `localStorage.wanscDebug = "1"`, reload, and read the
   `[WANSC]` lines. They show the notification, the sound, and the decision, without message text.
3. Compare against the table above to see which dependency moved:
   - `notifications` rising but `soundsHandled` flat: the sound is no longer recognised. Look at
     `whatsappShapes.sound` (host, type, route) and at the `[WANSC]` lines.
   - hook `missing` or `overwritten`: the hook could not install, or WhatsApp replaced it.
   - nothing counted at all while messages arrive: WhatsApp no longer calls `Notification` from the
     page (service-worker push).

## Fixing it

- A new sound host/type: widen `SOUND_HOST` / `SOUND_FILE` in `src/core/protocol.mjs`.
- A new sound route: add a wrapper in `installMainHook`, following `wrappedStart`, and a scenario in
  `tests/unit/main-hook-resilience.test.js`.
- A new chat-list structure: capture it, add it to `tests/fixtures/whatsapp-chat-list.html` or as
  a new variant in `tests/unit/markup-contract.test.js`, and make the contract pass (usually in
  `src/content/page-model.mjs`). The contract runs every reader against every variant.

Every change should start as a failing scenario in `tests/unit/main-hook-resilience.test.js` that models
what WhatsApp now does, so the same break cannot come back unnoticed.
