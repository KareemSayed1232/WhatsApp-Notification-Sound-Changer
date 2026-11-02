# Publishing (free stores only)

The plan for 3.0: an **unlisted beta** on the two free stores, plus a GitHub Release for every
other Chromium browser. The Chrome Web Store is skipped for now because it has a one-time US$5 fee.

| Where                  | Cost | Covers                                 | Package                                                     |
| ---------------------- | ---- | -------------------------------------- | ----------------------------------------------------------- |
| Firefox Add-ons (AMO)  | free | Firefox desktop, Firefox for Android   | `dist/packages/sound-changer-for-whatsapp-<v>-firefox.zip`  |
| Microsoft Edge Add-ons | free | Edge                                   | `dist/packages/sound-changer-for-whatsapp-<v>-chromium.zip` |
| GitHub Releases        | free | Chrome, Brave, Opera, Vivaldi (manual) | the same chromium zip                                       |

## 0. Before any store

- [ ] Every check in [PENDING-CHECKS.md](PENDING-CHECKS.md) under "Edge and Firefox on Windows" passes.
- [ ] Push the repo to GitHub, **public**, with **Issues** turned on (Settings → General → Features).
- [ ] `npm run check && npm run build && npm run lint:firefox && npm run package`. All clean.
- [ ] Tag the release: `git tag v3.0.0 && git push origin v3.0.0`.
- [ ] Create a GitHub Release for `v3.0.0`, attach both zips, and paste the CHANGELOG entry.
- [ ] The privacy policy URL is
      `https://github.com/KareemSayed1232/WhatsApp-Notification-Sound-Changer/blob/main/PRIVACY.md`
      (use the branch you push; it must be public).
- [ ] Screenshots (1280×800 or 640×400): the popup and the settings page. **Blur or rename every
      real chat name**, and show no WhatsApp logo. Use made-up chat names in a test account if you can.

## 1. Firefox Add-ons (AMO)

1. Sign in at <https://addons.mozilla.org/developers/> with a free Mozilla account.
2. **Submit a New Add-on**, then pick where it will be distributed:
   - **On your own** (unlisted beta): Mozilla signs it and gives you an `.xpi` to share. It
     installs permanently on desktop Firefox, but isn't searchable. Use this for the beta.
   - **On this site** (listed): public on AMO and searchable. Switch to this after the beta.
3. Upload the firefox zip. The add-on id `whatsapp-sound-changer@kareemsayed1232.github.io` is
   already in the build. **Never change it after the first upload.**
4. **Source code:** the code is bundled with esbuild, so AMO asks for the source. Upload a zip of
   the repository **without** `node_modules` and `dist`. In the reviewer notes, say:
   `npm ci && npm run build` produces `dist/firefox` (Node 20+); it uses no minifier and makes no
   remote calls.
5. Compatibility: Firefox desktop and, labelled experimental in the description, Firefox for Android.
6. Paste the listing text and reviewer notes below.

## 2. Microsoft Edge Add-ons

1. Register free at Microsoft Partner Center: <https://partner.microsoft.com/dashboard/microsoftedge/>
   (individual account, no fee).
2. **Create new extension**, then upload the chromium zip.
3. **Availability → Visibility: Hidden** for the beta (only people with the link can install).
   Switch it to **Public** later. If the option is named differently, look for "hidden" or "unlisted".
4. Fill in the properties: category **Productivity**, the privacy policy URL, and the support URL
   `https://github.com/KareemSayed1232/WhatsApp-Notification-Sound-Changer/issues`.
5. Paste the listing text, and put the reviewer notes in **Notes for certification**.

## 3. GitHub Release (Chrome, Brave, Opera, Vivaldi)

Attach the chromium zip to the release. The README explains **Load unpacked**. Manual installs don't
auto-update, so mention each new release in its notes.

## Listing text

**Name:** Sound Changer for WhatsApp

**Short description (≤132 characters):**
A different notification sound for each WhatsApp Web chat, and no desktop pop-ups. Not affiliated
with WhatsApp or Meta.

**Description:**

> Works while WhatsApp Web is open in a browser tab. When the tab or browser is closed, WhatsApp's
> background notification plays your browser's normal sound, and no extension can change that.
>
> Know who's writing without looking: give each chat, group or person in a group its own sound.
>
> - Upload your own sounds (mp3, wav, ogg, m4a, up to 2 MB) or use one default sound for everything.
> - Make chats silent. Chats muted in WhatsApp stay silent.
> - Hides WhatsApp's desktop pop-ups so only the sound plays (you can turn them back on).
> - A status line tells you if something stops working after a WhatsApp update.
> - Everything stays on your device: no servers, no analytics, no tracking.
>
> Firefox: click once in the WhatsApp tab after it loads, because Firefox blocks page sound until
> you do.
> Firefox for Android: experimental.
>
> Open source (GPLv3), a fork of mejia-dev's WhatsApp Notification Sound Changer. Problems: GitHub
> issues. Not affiliated with, endorsed by or sponsored by WhatsApp or Meta.

## Reviewer notes and permission justifications

Paste these as they are.

**Single purpose:** plays a user-chosen sound for each WhatsApp Web chat when a message arrives, and
optionally hides WhatsApp's desktop pop-up.

**Host permission `https://web.whatsapp.com/*`:** the only site the extension runs on. It watches
WhatsApp's notifications and sounds in that tab and plays the user's sound instead.

**`storage`:** keeps the user's settings, per-chat choices and uploaded sounds locally. Nothing is
synced or sent.

**`scripting`:** after install or update, it injects the same content scripts into WhatsApp tabs
that were already open, so the user doesn't have to reload WhatsApp. Only web.whatsapp.com tabs.

**Page-world script (`"world": "MAIN"`):** WhatsApp creates its notification and plays its sound
from page JavaScript, which an isolated content script can't observe. The page script wraps
`Notification`, `ServiceWorkerRegistration.showNotification`, `HTMLMediaElement.play` and
`AudioBufferSourceNode.start` on web.whatsapp.com only. It sends just the notification's title and
tag to the extension's isolated script, which decides what to play. Message text never leaves the
page script.

**`Notification.permission` reported as "granted":** only while the user's "hide pop-ups" setting is
on (the default). WhatsApp only announces each message (the event the extension relies on to tell
which chat it came from) when it believes notifications are allowed. The extension then suppresses
the pop-up itself, so the user sees none. The browser's real permission is never changed or
requested. With "Show WhatsApp's pop-up notifications" turned on, the real permission is reported.

**Remote code:** none. All code is in the package. There are no network requests and no analytics.

**Data collection:** none (Firefox `data_collection_permissions: none`).

**How to test:** open web.whatsapp.com and link a test account. Open the popup and press
**Refresh chat list**. Pick a chat and press **Upload sound** (any short mp3). Press **Play** to hear
it. Have that chat send a message with the tab in the background, and the uploaded sound plays with
no pop-up.

## Updating

1. Bump `version` in `src/manifest.json` **and** `package.json` (keep them the same).
2. Add a CHANGELOG entry.
3. `npm run check && npm run package`, then upload the new zips to each store and to a new GitHub
   Release.

## When to pull it

Unlist the add-on (both stores allow it in a click) if any of these happens:

- WhatsApp or Meta asks, or a store flags it for trademark or policy reasons.
- A privacy problem is reported and confirmed.
- A WhatsApp change breaks sounds and can't be fixed within two weeks. Say so in the listing and
  README meanwhile.
