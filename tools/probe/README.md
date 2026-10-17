# WANSC Probe (research only)

A tiny throwaway extension that answers Phase 0 questions about how WhatsApp Web notifies you. It
logs and passes everything through unchanged. It is **not** part of the shipped extension.

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
4. Keep the WhatsApp tab in the background (another tab focused) while the messages arrive, so that
   WhatsApp raises a notification.
5. Export what was captured:
   ```js
   copy(JSON.stringify(__wansc_probe, null, 2));
   ```

## Privacy

The log contains contact/group names and message text (`body`). **Replace real names and message
text with fake ones before sharing it.** Using test chats avoids the issue.

## What we are trying to learn

| Question                                                                   | Where to look                      |
| -------------------------------------------------------------------------- | ---------------------------------- |
| Does `kind: "notification"` appear at all (vs `showNotification`)?         | `kind`                             |
| Is `title` the contact name? In groups, is it the group name?              | `title`                            |
| In groups, does `body` start with `Sender: `?                              | `options.body`                     |
| Is there a stable chat id in `tag` or `data`?                              | `options.tag`, `options.data.json` |
| Does WhatsApp's own ping go through `<audio>` (`media.play`) or Web Audio? | `kind`, `src`                      |
