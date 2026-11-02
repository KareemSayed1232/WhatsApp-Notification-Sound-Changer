# 3.0.0 - unreleased (beta)

**Your sounds play in WhatsApp's own kind of player.** The sounds in use are handed to WhatsApp's page when it opens; when WhatsApp plays its ding, your sound plays at once in a player WhatsApp's page creates. No separate audio engine, nothing loaded at the moment a message arrives, and if your sound is not there WhatsApp's own plays: never silence.

**Sound logic: follow WhatsApp, never guess from its page.** Sounds are decided only from what
WhatsApp itself does: its notification (which names the chat by its unique id) and its message
sound. With a notification, the chat's own sound plays; WhatsApp's sound with no notification
(WhatsApp focused) gets your default sound; when WhatsApp makes no sound, neither does the
extension. Removed: reading the chat list, unread badges and mute icons to decide sounds, learned
mutes, the background backup, holding sounds, rules for one person inside a group, and moving
rules between chats by name. "Refresh chat list" stays, for showing chats in the popup only; a
rule made from a listed name is tied to the chat's id at its first notification.

Renamed **Sound Changer for WhatsApp**. A rewrite of the original by mejia-dev.

- A different sound per chat, group or person in a group, plus a default sound, Silent, or
  WhatsApp's own sound.
- Hides WhatsApp's desktop pop-ups, so only the sound plays (optional).
- Respects chats muted in WhatsApp, including ones muted before the extension was installed.
- Keeps two chats with the same name apart.
- Sounds while the WhatsApp tab is focused, too.
- Firefox (desktop) support. Firefox for Android is experimental.
- A status line, plus a Troubleshooting section with copyable diagnostics (no names or messages).
- First-run steps and a **Play** button on each chat in the popup.
- Tells you when the browser needs one click in WhatsApp before it can play sound, with an
  **Open WhatsApp** button.
- Uploading the same sound file twice keeps one copy.
- Lower CPU use while WhatsApp is open.
- Less dependent on WhatsApp:
  - the chat list backs up WhatsApp's notifications in the background;
  - the hook puts itself back if WhatsApp replaces what it wrapped;
  - a WhatsApp sound up to 3 s late still gets the right chat's sound.
- One sound per message: every sound goes through one gate (one per chat per message, never two
  a moment apart, never one that comes late after the tab was frozen). Chat-list messages are
  matched to WhatsApp's notifications by chat instead of by a 2-second window, so a message seen
  late in a background tab no longer causes a second sound or a false "muted".
- Guesses about WhatsApp's page are checked before they are trusted or saved: the unread badge
  is never read as a chat's name, WhatsApp's "message sent" sound is never learned as the incoming
  sound, a rule is never moved to another chat that merely shares its name, and an "unmute" icon
  is not a mute marker.
- Troubleshooting: **Run a self-test**, and **Copy page layout** (names and messages replaced) for
  bug reports.
- Support through GitHub issues. Safari and macOS aren't supported.

# 2.0 - 2026-03-08
- Added functionality to a stop sound if it's playing. Useful for long sounds (suggested by [@Selvandiran](https://github.com/Selvandiran)).
- Overhauled UI to match with current WhatsApp Web UI.
- Added tipping page link

# 1.0 - Initial Release