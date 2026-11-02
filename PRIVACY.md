# Privacy policy: Sound Changer for WhatsApp

_Last updated: 29 October 2026_

**Short version: everything stays on your device. The extension sends nothing to anyone, has no
servers, no analytics and no tracking.**

## What the extension reads

It runs only on `https://web.whatsapp.com`. To pick the right sound it reads:

- **The title and tag of each WhatsApp notification.** The title is the chat's name (and, in groups,
  the sender's name). The tag is WhatsApp's id for the chat. It does **not** keep the message text.
- **The names of your chats in WhatsApp's chat list**, their unread counters and whether they show a
  mute icon. This lets you pick chats from a list and keeps muted chats silent.

## What it stores, and where

Only in your browser's own extension storage, on your device:

- your settings, your per-chat choices, and the names and ids of chats you've seen or picked;
- the sound files you upload;
- what it learned about WhatsApp's page layout and which chats are muted;
- a status record of counts and timings (for example "3 notifications, 3 sounds handled"), used for
  the "Is it working?" line.

None of this is synced, uploaded or shared. If you remove the extension, the browser deletes it all.

## What leaves your device

**Nothing, automatically.** The extension makes no network requests of its own.

The diagnostics report under **Settings → Troubleshooting** is created only when you press
**Copy diagnostics**. It goes to your clipboard and nowhere else. It holds the extension version,
your browser's version, counts and the kinds of things WhatsApp did. It has **no** chat names, ids,
phone numbers, messages, sound names or sound files. You choose whether to paste it anywhere.

## Permissions, and why

| Permission                             | Why                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Access to `https://web.whatsapp.com/*` | To notice new messages and play your sound in that tab. No other site is touched.                     |
| `storage`                              | To keep your settings and sounds on your device.                                                      |
| `scripting`                            | To start working in a WhatsApp tab that was already open when the extension was installed or updated. |

## Notifications

When pop-ups are hidden (the default), the extension tells the WhatsApp page that notifications are
allowed, so WhatsApp keeps announcing each message, which is how the extension knows which chat it
came from. The extension then hides the pop-up. Your browser's real notification setting isn't
changed.

## Children

The extension collects no personal data from anyone, including children.

## Changes and contact

Changes to this policy are made in this file, and its history is public on GitHub. Questions:
[open an issue](https://github.com/KareemSayed1232/WhatsApp-Notification-Sound-Changer/issues).

This project is not affiliated with WhatsApp or Meta.
