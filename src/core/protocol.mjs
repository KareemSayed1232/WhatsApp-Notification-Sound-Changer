// Names and helpers shared by the page-world hook, the content bridge and the background worker.

// WhatsApp Web's address. If WhatsApp ever moves, change it here and in manifest.json (the
// manifest cannot import it; a test keeps the two in step).
export const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
export const WHATSAPP_MATCH = `${WHATSAPP_ORIGIN}/*`;

// DOM events between the page world (hook) and the isolated world (bridge). Dispatch is
// synchronous, which lets the hook ask a question and read the answer in the same call.
export const EVENT_ASK = "wansc:ask";
export const EVENT_ANSWER = "wansc:answer";
export const EVENT_PLAY = "wansc:play";
// A newly started bridge announces itself so any older copy still alive in the tab (left behind
// when the extension was reloaded or updated) stops answering and playing.
export const EVENT_REPLACE = "wansc:replace";
// Hook -> bridge, one-way: what happened to WhatsApp's sound, for the status line.
export const EVENT_SIGNAL = "wansc:signal";
// Bridge -> hook: "are you still installed and in place?" The hook answers with EVENT_PONG.
export const EVENT_PING = "wansc:ping";
export const EVENT_PONG = "wansc:pong";
// Bridge -> hook: play WhatsApp's own incoming-message sound (used while WhatsApp is focused, so
// every browser sounds the same even where WhatsApp itself plays nothing).
export const EVENT_PLAY_NATIVE = "wansc:play-native";

// chrome.runtime messages from the bridge to the background worker.
export const MSG_GET_SOUND = "wansc:get-sound";
export const MSG_SEEN = "wansc:seen";
// Names read from WhatsApp's chat list, sent by the content script to the background worker.
export const MSG_CHATS = "wansc:chats";
// Extension page -> content script in the WhatsApp tab: scroll through the chat list and report it.
export const MSG_SCAN = "wansc:scan-chats";
// Content script -> background: WhatsApp gave a chat a new kind of id; move the rule onto it.
export const MSG_REBIND = "wansc:rebind-rule";
// chrome.storage.local key for what the content script learned about WhatsApp's page.
export const PAGE_MODEL_KEY = "pageModel";

// WhatsApp plays its message sound ~2-26 ms after raising the notification (measured, Oct 2026).
// The window is deliberately generous so a slow machine still pairs them.
export const PAIRING_WINDOW_MS = 500;
// A notification that no sound follows within this long counts as "silent" for the status line.
export const NO_SOUND_WINDOW_MS = 1500;
// A notification WhatsApp did not mark silent would have made the operating system ring. If no
// sound of WhatsApp's own follows within this long, we play the chosen sound ourselves.
export const SELF_PLAY_MS = 150;

// Incoming-message sound files measured on WhatsApp Web. Only these (plus any the hook has learned
// from a notification-paired sound) are replaced when no notification preceded the sound, e.g.
// when the tab is focused; other sounds are left alone.
export const KNOWN_INCOMING_SOUND_URL = "https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3";
const KNOWN_INCOMING_SOUND_FILES = ["BS_BUUXbKq5.mp3"];

// WhatsApp serves its static assets from these hosts. The file type is not assumed to stay mp3.
const SOUND_HOST = /(^|\.)whatsapp\.(net|com)$/;
const SOUND_FILE = /\.(mp3|ogg|oga|opus|m4a|aac|wav|webm)$/i;

function parseUrl(url) {
  try {
    return new globalThis.URL(url);
  } catch {
    return null;
  }
}

/** Any audio file served from a WhatsApp asset host. */
export function isWhatsAppSound(url) {
  const parsed = parseUrl(url);
  return parsed !== null && SOUND_HOST.test(parsed.hostname) && SOUND_FILE.test(parsed.pathname);
}

/** The file name of a sound URL ("" when it has none). */
export function soundFileName(url) {
  const parsed = parseUrl(url);
  return parsed ? (parsed.pathname.split("/").pop() ?? "") : "";
}

/**
 * The sound WhatsApp plays for an incoming message: the measured file, or one the hook learned
 * by seeing it play right after a notification (so a renamed file heals itself).
 */
export function isKnownIncomingSound(url, learned = []) {
  if (!isWhatsAppSound(url)) return false;
  const file = soundFileName(url);
  return file !== "" && (KNOWN_INCOMING_SOUND_FILES.includes(file) || learned.includes(file));
}
