import { createAudioEngine } from "./audio-engine.mjs";
import { createSoundLoader, startBridge } from "./bridge.mjs";
import { startChatWatcher } from "./chat-watcher.mjs";
import { startUnreadWatcher } from "./unread-watcher.mjs";

// Content script (isolated world) entry point; bundled to content/bridge.js.
const chrome = globalThis.chrome;
const document = globalThis.document;

const engine = createAudioEngine({
  AudioContextCtor: globalThis.AudioContext || globalThis.webkitAudioContext,
  loadSound: createSoundLoader(chrome),
  onError: (error) => globalThis.console.debug("[WANSC]", error.message),
});

/** Opt-in tracing: run `localStorage.wanscDebug = "1"` in the page console, then reload. */
function log(...args) {
  try {
    if (globalThis.localStorage?.getItem("wanscDebug"))
      globalThis.console.debug("[WANSC]", ...args);
  } catch {
    // Best-effort only.
  }
}

engine.armUnlock(document);
// Ask for audio as soon as WhatsApp loads, so it is usually running before the first message.
engine.canPlay();
const bridge = startBridge({ chrome, document, engine, log });
try {
  startChatWatcher({ chrome, document });
} catch (error) {
  // Reading the chat list is a convenience; it must never get in the way of the sounds.
  log("chat list watcher failed to start:", error.message);
}
try {
  // New messages while WhatsApp is focused, which some browsers' WhatsApp leaves silent.
  startUnreadWatcher({ document, onIncoming: bridge.onIncomingChat });
} catch (error) {
  log("unread watcher failed to start:", error.message);
}
