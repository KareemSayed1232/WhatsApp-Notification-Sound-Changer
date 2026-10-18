// Names and helpers shared by the page-world hook, the content bridge and the background worker.

// DOM events between the page world (hook) and the isolated world (bridge). Dispatch is
// synchronous, which lets the hook ask a question and read the answer in the same call.
export const EVENT_ASK = "wansc:ask";
export const EVENT_ANSWER = "wansc:answer";
export const EVENT_PLAY = "wansc:play";
// A newly started bridge announces itself so any older copy still alive in the tab (left behind
// when the extension was reloaded or updated) stops answering and playing.
export const EVENT_REPLACE = "wansc:replace";

// chrome.runtime messages from the bridge to the background worker.
export const MSG_GET_SOUND = "wansc:get-sound";
export const MSG_SEEN = "wansc:seen";
// Names read from WhatsApp's chat list, sent by the content script to the background worker.
export const MSG_CHATS = "wansc:chats";
// Extension page -> content script in the WhatsApp tab: scroll through the chat list and report it.
export const MSG_SCAN = "wansc:scan-chats";

// WhatsApp plays its message sound ~2-26 ms after raising the notification (measured, Oct 2026).
// The window is deliberately generous so a slow machine still pairs them.
export const PAIRING_WINDOW_MS = 500;

// Incoming-message sound files measured on WhatsApp Web. Only these are replaced when no
// notification preceded the sound (e.g. the tab is focused); other sounds are left alone.
const KNOWN_INCOMING_SOUND_FILES = ["BS_BUUXbKq5.mp3"];

function parseUrl(url) {
  try {
    return new globalThis.URL(url);
  } catch {
    return null;
  }
}

/** Any mp3 served from WhatsApp's static asset host. */
export function isWhatsAppSound(url) {
  const parsed = parseUrl(url);
  return (
    parsed !== null && parsed.hostname === "static.whatsapp.net" && /\.mp3$/.test(parsed.pathname)
  );
}

/** The specific mp3 WhatsApp plays for an incoming message. */
export function isKnownIncomingSound(url) {
  if (!isWhatsAppSound(url)) return false;
  const { pathname } = parseUrl(url);
  return KNOWN_INCOMING_SOUND_FILES.some((file) => pathname.endsWith(`/${file}`));
}
