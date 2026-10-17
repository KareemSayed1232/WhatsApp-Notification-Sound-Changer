# WANSC Probe (research only)

A tiny throwaway extension that answers Phase 0 questions about how WhatsApp Web notifies you. It
is **not** part of the shipped extension.

**No desktop popups.** The probe tells WhatsApp that notification permission is granted, then
swallows each notification instead of showing it. You do **not** need to allow notifications in
your browser, and none will appear. (Your browser's real permission is logged as `page.permission`.)
Audio is passed through untouched, so WhatsApp's own sound still plays.

## Install

- **Chrome / Edge / Brave:** open `chrome://extensions`, enable Developer mode, **Load unpacked**,
  choose this `tools/probe` folder.
- **Firefox (128+):** open `about:debugging#/runtime/this-firefox`, **Load Temporary Add-on**,
  choose `tools/probe/manifest.json`.

## Capture

1. Open https://web.whatsapp.com and log in. **Reload the tab** after installing the probe.
2. Open DevTools (F12) → Console. Type `WANSC-PROBE` in the filter box.
3. From a second phone/account, send yourself:
   - a 1:1 message from a contact with a normal name,
   - a message from a contact whose name contains emoji or non-Latin letters,
   - a message in a group,
   - an image, and a voice message.
4. WhatsApp only raises a notification when its tab is **hidden or unfocused**. So:
   - In WhatsApp Web, open Settings → Notifications and make sure message notifications are on
     (this is WhatsApp's own setting, separate from the browser permission).
   - Switch to a **different browser tab** (or another app's window) before the message arrives.
     Do not type `new Notification(...)` yourself: that tests the probe, not WhatsApp.
   - After the messages arrive, come back and read the log. Each entry has a `page` field showing
     `visible`, `focused` and the real browser `permission`.
5. Export what was captured:
   ```js
   copy(JSON.stringify(__wansc_probe, null, 2));
   ```

## Privacy

The log never contains message text: for `body` it records only the length and any `Name: ` prefix.
It does contain contact/group names and chat ids (`tag`), which can include phone numbers.
**Replace those with fake values before sharing it.** Using test chats avoids the issue.

## What we are trying to learn

| Question                                                                   | Where to look                      |
| -------------------------------------------------------------------------- | ---------------------------------- |
| Does `kind: "notification"` appear at all (vs `showNotification`)?         | `kind`                             |
| Is `title` the contact name? In groups, is it the group name?              | `title`                            |
| In groups, does `body` start with `Sender: `?                              | `options.body`                     |
| Is there a stable chat id in `tag` or `data`?                              | `options.tag`, `options.data.json` |
| Does WhatsApp's own ping go through `<audio>` (`media.play`) or Web Audio? | `kind`, `src`                      |
