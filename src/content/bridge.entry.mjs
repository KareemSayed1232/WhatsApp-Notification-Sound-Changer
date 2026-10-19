import { createAudioEngine } from "./audio-engine.mjs";
import { createSoundLoader, startBridge } from "./bridge.mjs";
import { startChatWatcher } from "./chat-watcher.mjs";
import { createMuteLearner } from "./mute-learner.mjs";
import { createPageModel } from "./page-model.mjs";
import { startUnreadWatcher } from "./unread-watcher.mjs";
import { PAGE_MODEL_KEY } from "../core/protocol.mjs";

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
let learning = null;
const bridge = startBridge({
  chrome,
  document,
  engine,
  log,
  onNotification: (notification) => learning?.onNotification(notification),
});

const SAVE_DELAY_MS = 1000;
// How often the chat list is checked for being readable (3 failed checks in a row warn).
const PAGE_CHECK_MS = 60_000;
// WhatsApp updates the chat list just after it notifies; look at the row a moment later.
const LEARN_DELAY_MS = 1000;

/**
 * Reading WhatsApp's chat list in a way that teaches itself (page-model.mjs) and learning which
 * chats are muted from WhatsApp's own behaviour (mute-learner.mjs). What was learned is kept in
 * chrome.storage so it survives a reload.
 */
function startLearning(saved) {
  let notificationsSeen = 0;
  let saveTimer = null;

  const model = createPageModel({
    document,
    knownNames: () => bridge.knownChatNames(),
    learned: saved?.fingerprints,
    onLearn: () => save(),
  });
  const mutes = createMuteLearner({
    initial: saved?.muted,
    // If no notification has arrived at all, every chat would look muted: learn nothing then.
    canLearn: () => notificationsSeen > 0,
    onChange: () => save(),
  });

  function save() {
    if (saveTimer !== null) return;
    saveTimer = globalThis.setTimeout(() => {
      saveTimer = null;
      try {
        const value = { fingerprints: model.learned(), muted: mutes.snapshot() };
        const result = chrome.storage.local.set({ [PAGE_MODEL_KEY]: value });
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch {
        // The extension may have been reloaded; it learns again.
      }
    }, SAVE_DELAY_MS);
  }

  // Tell the status line whether WhatsApp's chat list can still be read, and how.
  globalThis.setInterval(() => {
    try {
      const chats = model.readChats();
      bridge.report({ type: "page", readable: chats.size > 0, layers: model.layers() });
    } catch {
      // A check is a nicety.
    }
  }, PAGE_CHECK_MS);

  learning = {
    onNotification({ title }) {
      notificationsSeen += 1;
      mutes.noteNotification(title);
      globalThis.setTimeout(() => model.learnFrom(title), LEARN_DELAY_MS);
    },
  };

  try {
    startChatWatcher({ chrome, document, readNames: model.readNames, findPane: model.findPane });
  } catch (error) {
    // Reading the chat list is a convenience; it must never get in the way of the sounds.
    log("chat list watcher failed to start:", error.message);
  }
  try {
    startUnreadWatcher({
      document,
      // New messages while WhatsApp is focused, which some browsers' WhatsApp leaves silent.
      onIncoming: bridge.onIncomingChat,
      read: model.readChats,
      findPane: model.findPane,
      // A mute marker on the page, or a mute learned from WhatsApp's behaviour.
      isMuted: (name, chat) => mutes.resolve(name, chat.muted),
      // Notice mute markers appear (muted) and disappear (unmuted) as the user changes them.
      onRead: (chats) => {
        for (const chat of chats.values()) mutes.noteMarker(chat.name, chat.muted);
      },
      onRise: ({ name }) => {
        // Only a truly hidden tab: there WhatsApp notifies every unmuted chat.
        if (document.visibilityState === "hidden") mutes.noteBackgroundRise(name);
      },
    });
  } catch (error) {
    log("unread watcher failed to start:", error.message);
  }
}

Promise.resolve()
  .then(() => chrome.storage.local.get([PAGE_MODEL_KEY]))
  .then(
    (stored) => stored?.[PAGE_MODEL_KEY] ?? null,
    () => null
  )
  .then(startLearning)
  .catch((error) => log("learning failed to start:", error?.message));
