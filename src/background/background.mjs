import { bytesToDataUrl } from "../core/audio-data.mjs";
import { MSG_GET_SOUND, MSG_SEEN } from "../core/protocol.mjs";

const WHATSAPP_ORIGIN = "https://web.whatsapp.com/";
const MAX_SEEN_ITEMS = 4;

/**
 * The only place that touches IndexedDB and migrations. Content scripts ask it for sound bytes
 * and report which chats they saw; nothing else runs here, so it works as a Chrome service
 * worker and as a Firefox event page alike.
 */
export function startBackground({ chrome, stateStore, soundStore }) {
  const extensionOrigin = chrome.runtime.getURL("");

  /** Only our own pages and our content script on WhatsApp Web may talk to us. */
  function isTrusted(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    const url = sender.url || sender.tab?.url || "";
    return url.startsWith(WHATSAPP_ORIGIN) || url.startsWith(extensionOrigin);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !isTrusted(sender)) return false;

    if (message.type === MSG_GET_SOUND && typeof message.soundId === "string") {
      soundStore.get(message.soundId).then(
        (record) =>
          sendResponse(
            record
              ? { ok: true, dataUrl: bytesToDataUrl(record.mime, new Uint8Array(record.data)) }
              : { ok: false }
          ),
        () => sendResponse({ ok: false })
      );
      return true; // Keep the channel open for the async response.
    }

    if (message.type === MSG_SEEN && Array.isArray(message.items)) {
      for (const item of message.items.slice(0, MAX_SEEN_ITEMS)) {
        if (item && typeof item === "object") {
          stateStore
            .recordSender({ name: item.name, kind: item.kind, chatId: item.chatId })
            .catch(() => {});
        }
      }
    }
    return false;
  });

  const load = () => stateStore.load().catch(() => {});
  chrome.runtime.onInstalled.addListener(load);
  chrome.runtime.onStartup.addListener(load);

  // Interim: the old popup still stores uploads under `uploadedAudio`; import them as they arrive.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && typeof changes.uploadedAudio?.newValue === "string") {
      stateStore.migrateLegacy().catch(() => {});
    }
  });

  load();
}
