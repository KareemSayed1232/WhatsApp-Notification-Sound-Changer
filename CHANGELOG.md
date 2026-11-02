# 3.0.0 - unreleased (beta)

Renamed **Sound Changer for WhatsApp**. A rewrite of the original by mejia-dev.

**How it decides a sound: it follows WhatsApp and never guesses from its page.** It reacts only to
what WhatsApp itself does. When WhatsApp raises a notification, which names the chat by its unique
id, that chat's sound plays. When WhatsApp plays its sound with no notification (WhatsApp focused),
your default sound plays, or WhatsApp's own. When WhatsApp makes no sound, neither does the
extension, so mutes and @mentions behave exactly as in WhatsApp.

**Your sounds play inside the WhatsApp tab.** The sounds in use are handed to the WhatsApp page when
it opens, and play there the moment WhatsApp plays its ding. If your sound isn't there, WhatsApp's
own plays: never silence.

- A different sound per chat or group, plus a default sound, Silent, or WhatsApp's own sound.
- An uploaded sound never becomes the default by itself: you pick the default.
- Chats you add by name are tied to the chat's id at its first notification, and the popup shows
  "Linked ✓" or "Waiting for first message".
- Two chats with the same name are kept apart.
- Hides WhatsApp's desktop pop-ups, so only the sound plays (optional).
- Firefox (desktop) support. Firefox for Android is experimental.
- A status line, including when WhatsApp's own notifications are off (then only the default sound
  can play), plus a Troubleshooting section: **Copy diagnostics** (no names or messages),
  **Run a self-test** and **Copy page layout** (names and messages replaced).
- First-run steps and a **Play** button on each chat in the popup.
- Uploading the same sound file twice keeps one copy.
- The page hook puts itself back if WhatsApp replaces what it wrapped, and a WhatsApp sound up to
  3 s late still gets the right chat's sound. One sound per message.
- If your sound fails to play (a file the browser can't decode), WhatsApp's own plays instead and
  the status line says so; a block until you click is reported too. Both clear once a sound plays.
- Only the chat's name and id leave WhatsApp's page, never the message text.
- Your sounds are handed to the WhatsApp page only when they change, not on every message.
- Removed: rules for one person inside a group, and everything that read WhatsApp's page to decide
  a sound (unread badges, mute icons, learned mutes, the background backup). "Refresh chat list"
  stays, only to show chats in the popup.
- Support through GitHub issues. Safari and macOS aren't supported.

# 2.0 - 2026-03-08
- Added functionality to a stop sound if it's playing. Useful for long sounds (suggested by [@Selvandiran](https://github.com/Selvandiran)).
- Overhauled UI to match with current WhatsApp Web UI.
- Added tipping page link

# 1.0 - Initial Release