<h1 align="center"><img src="./src/icons/icon-48.png" alt="" width="28" /> Sound Changer for WhatsApp</h1>
<p align="center">A different notification sound for each WhatsApp Web chat, and no desktop pop-ups.</p>
<p align="center"><em>Not affiliated with WhatsApp or Meta.</em></p>

<hr />

> **Read this first: it only works while WhatsApp Web is open in a browser tab.**
> When the tab or the browser is closed, WhatsApp's own background notification shows up with your
> browser's normal sound. No extension can change that notification (details under
> [Limits](#limits)).

## What it does

- **A sound per chat.** Give Mom, a work group or one person their own sound, so you know who is
  writing without looking. Every other chat uses your default sound, or WhatsApp's own.
- **Silent chats.** Make a chat play nothing.
- **No pop-ups.** WhatsApp's desktop pop-ups are hidden and only the sound plays. You can turn
  pop-ups back on in settings.
- **Respects mute.** Chats you muted in WhatsApp stay silent.
- **Two chats with the same name** are kept apart once each has messaged you. A group shows as
  one row, even if WhatsApp named it under more than one id.
- **Tells you when something is wrong.** The popup has a status line, and settings has a
  Troubleshooting section with a diagnostics report you can copy.
- Your sounds and settings stay on your device. Nothing is sent anywhere ([privacy](PRIVACY.md)).

## Install

| Browser                       | How                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Firefox (Windows, Linux)      | Firefox Add-ons (link added once it's published)                                                            |
| Microsoft Edge                | Edge Add-ons (link added once it's published)                                                               |
| Chrome, Brave, Opera, Vivaldi | From [Releases](https://github.com/KareemSayed1232/WhatsApp-Notification-Sound-Changer/releases), see below |
| Firefox for Android           | **Experimental.** Same Firefox build, but not yet checked on a phone                                        |

**Chrome, Brave, Opera and Vivaldi (manual install):**

1. Download `sound-changer-for-whatsapp-<version>-chromium.zip` from the latest
   [release](https://github.com/KareemSayed1232/WhatsApp-Notification-Sound-Changer/releases) and
   unzip it to a folder you'll keep.
2. Open `chrome://extensions` (or `brave://extensions`, `opera://extensions`).
3. Turn on **Developer mode**, click **Load unpacked**, and choose the unzipped folder.

Manual installs don't update themselves. Download each new release the same way. Chrome may also
remind you at startup that a developer-mode extension is installed. That's expected.

## First use

1. Open [WhatsApp Web](https://web.whatsapp.com) in a tab, open the extension's popup and press
   **Refresh chat list**.
2. Search for a chat and pick a sound, or press **Upload sound** to use your own file (mp3, wav,
   ogg, m4a, up to 2 MB).
3. Press **Play** to hear it. The next message from that chat plays it.

**Firefox:** Firefox doesn't let a page play sound until you've clicked in it once. After opening or
reloading WhatsApp, click anywhere in the WhatsApp tab. If you haven't, the popup reminds you and
offers an **Open WhatsApp** button.

## Limits

- **Closed tab or closed browser:** WhatsApp then notifies through its background service worker
  (web push). That notification never passes through the page, so its sound and pop-up can't be
  changed. Keep the WhatsApp Web tab open, pinned if you like.
- **Firefox needs one click** in the WhatsApp tab after it loads (see above).
- **While WhatsApp is the focused window**, WhatsApp doesn't say which chat a message is from, so
  you hear your default sound (Firefox makes no sound there at all, like WhatsApp itself).
- **Chats added by name** show "Waiting for first message" until that chat messages you; the
  sound is then tied to that chat.
- **Two chats with the same name:** a sound added by name goes to whichever of them messages
  first. The other one keeps WhatsApp's sound (or your default). WhatsApp Web shows no chat ids on
  the page, so the two can't be told apart before they message. Pick the sound from the chat's
  own row once it has messaged instead.
- **No sound from WhatsApp, no sound from the extension.** WhatsApp sometimes plays nothing: muted
  chats (except @mentions), and further quick messages in the same chat. The extension only
  replaces sounds WhatsApp actually makes, so it is silent then too.
- **WhatsApp Web changes without notice.** The extension is built to adapt (see
  [what it depends on](docs/WEAK-POINTS.md)). If it stops working, the status line says so.
- **Android is experimental.** WhatsApp Web needs Firefox's _Desktop site_, and Android pauses
  background tabs.

## Problems and support

Open an [issue on GitHub](https://github.com/KareemSayed1232/WhatsApp-Notification-Sound-Changer/issues).
It helps to include the report from **Settings → Troubleshooting → Copy diagnostics**. It contains
counts and versions only, with no chat names or messages.

## Build from source

Node 20 or newer:

```bash
npm install
npm test             # unit and integration tests
npm run build        # dist/chromium and dist/firefox
npm run package      # dist/packages/*.zip for the stores
```

More in [docs/BROWSERS.md](docs/BROWSERS.md). Publishing steps are in [docs/STORES.md](docs/STORES.md).

## Credits and licence

This is a fork of [WhatsApp Notification Sound Changer](https://github.com/mejia-dev/WhatsApp-Notification-Sound-Changer)
by [mejia-dev](https://github.com/mejia-dev), which set one custom sound for WhatsApp Web. Version
3.0 rewrites it with per-chat sounds, pop-up hiding, mute handling and Firefox support.

Licensed under the [GNU GPL v3](LICENSE.txt), the same as the original.

WhatsApp is a trademark of WhatsApp LLC. This project is not affiliated with, endorsed by or
sponsored by WhatsApp or Meta.
