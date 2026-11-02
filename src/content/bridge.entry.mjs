import { startBridge } from "./bridge.mjs";
import { findChatPane, readChatNames } from "./chat-list.mjs";
import { startChatWatcher } from "./chat-watcher.mjs";
import { runSelfTest } from "./self-test.mjs";
import { MSG_SELF_TEST, PAGE_MODEL_KEY } from "../core/protocol.mjs";

// Content script (isolated world) entry point; bundled to content/bridge.js.
//
// Sounds are decided only from what WhatsApp itself does (its notifications and its message
// sound, passed on by the page hook): nothing here reads WhatsApp's page to decide a sound. The
// one page reader left is the chat-list collector behind "Refresh chat list", which only fills
// the popup's list of chats.
const chrome = globalThis.chrome;
const document = globalThis.document;

/** Opt-in tracing: run `localStorage.wanscDebug = "1"` in the page console, then reload. */
function log(...args) {
  try {
    if (globalThis.localStorage?.getItem("wanscDebug"))
      globalThis.console.debug("[WANSC]", ...args);
  } catch {
    // Best-effort only.
  }
}

// Your sounds are played by the page hook itself, in a player WhatsApp's page creates.
const bridge = startBridge({ chrome, document, log });

// What older versions learned from the page (chat-list fingerprints, guessed mutes) is no longer
// used for anything: remove it.
try {
  const removed = chrome.storage.local.remove?.(PAGE_MODEL_KEY);
  if (removed && typeof removed.catch === "function") removed.catch(() => {});
} catch {
  // Nothing to clean up.
}

// "Refresh chat list": collect chat names for the popup's list. Display only.
try {
  startChatWatcher({ chrome, document });
} catch (error) {
  log("chat list collector failed to start:", error.message);
}

// Settings → Troubleshooting → Run a self-test: checked here, in the WhatsApp tab.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== MSG_SELF_TEST || sender?.id !== chrome.runtime.id) return false;
  const checks = runSelfTest({
    hookState: bridge.hookState,
    settings: bridge.settings(),
    readChats: () => new Map(readChatNames(document).map((name) => [name, { name }])),
    layers: () => ({ list: findChatPane(document) ? "builtin" : "none" }),
    canPlay: () => bridge.soundsReady(),
  });
  sendResponse({ ok: true, checks });
  return false;
});
