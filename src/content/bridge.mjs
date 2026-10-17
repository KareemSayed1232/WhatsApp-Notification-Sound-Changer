import { parseDataUrl } from "../core/audio-data.mjs";
import { decidePlayback, parseSenderFromBody } from "../core/matcher.mjs";
import { cleanDisplayName } from "../core/normalize.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PLAY,
  EVENT_REPLACE,
  MSG_GET_SOUND,
  MSG_SEEN,
} from "../core/protocol.mjs";
import { readState } from "../core/state-store.mjs";

const text = (value) => (typeof value === "string" ? value : "");

function parse(detail) {
  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

/** Fetches a sound's bytes from the background worker, which owns the IndexedDB store. */
export function createSoundLoader(chrome) {
  return async function loadSound(soundId) {
    const response = await chrome.runtime.sendMessage({ type: MSG_GET_SOUND, soundId });
    if (!response?.ok) return null;
    const parsed = parseDataUrl(response.dataUrl);
    return parsed ? { mime: parsed.mime, bytes: parsed.bytes } : null;
  };
}

/**
 * The isolated-world half of the extension. It owns a cached copy of the rules and answers the
 * page-world hook's questions synchronously, so contact names and rules never enter the page.
 */
export function startBridge({
  chrome,
  document,
  engine,
  CustomEventCtor = document.defaultView.CustomEvent,
}) {
  let state = null;

  async function refresh() {
    try {
      state = await readState(chrome.storage.local);
    } catch {
      // Keep the last good state (e.g. the extension was reloaded under us).
    }
  }

  /** Tell the background which chats we saw, so the options page can offer them. Names only. */
  function reportSeen({ title, tag, body }) {
    const items = [];
    const name = cleanDisplayName(title);
    if (name) items.push({ name, kind: "chat", ...(tag ? { chatId: tag } : {}) });
    if (tag.endsWith("@g.us")) {
      const sender = cleanDisplayName(parseSenderFromBody(body));
      if (sender) items.push({ name: sender, kind: "sender" });
    }
    if (items.length === 0) return;
    try {
      const result = chrome.runtime.sendMessage({ type: MSG_SEEN, items });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // The extension context may be gone; sounds still work from the cached state.
    }
  }

  function answerFor(question) {
    const { settings, rules, sounds } = state;
    switch (question.kind) {
      case "permission":
        return { spoof: settings.enabled && !settings.showPopups };

      case "notification": {
        if (!settings.enabled) return { mode: "pass" };
        const notification = {
          title: text(question.title),
          tag: text(question.tag),
          body: text(question.body),
        };
        reportSeen(notification);
        return {
          mode: "managed",
          decision: decidePlayback({ notification, rules, sounds, settings }),
          showPopup: settings.showPopups,
        };
      }

      case "default-sound":
        if (!settings.enabled) return { decision: { action: "native" } };
        return { decision: decidePlayback({ notification: {}, rules, sounds, settings }) };

      default:
        return null;
    }
  }

  /** After the extension is reloaded or updated, this copy loses its extension APIs. */
  function isOrphaned() {
    try {
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  }

  function onAsk(event) {
    if (isOrphaned()) return stop(); // Go quiet: the hook then leaves WhatsApp untouched.
    const question = parse(event.detail);
    if (!state || !question) return; // Not ready: the hook leaves WhatsApp untouched.
    const answer = answerFor(question);
    if (answer) {
      document.dispatchEvent(new CustomEventCtor(EVENT_ANSWER, { detail: JSON.stringify(answer) }));
    }
  }

  function onPlay(event) {
    if (isOrphaned()) return stop();
    const request = parse(event.detail);
    if (!request || typeof request.soundId !== "string") return;
    engine.play(request.soundId, request.volume);
  }

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    if (changes.sounds) engine.invalidate();
    refresh();
  }

  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    document.removeEventListener(EVENT_ASK, onAsk);
    document.removeEventListener(EVENT_PLAY, onPlay);
    document.removeEventListener(EVENT_REPLACE, stop);
    try {
      chrome.storage.onChanged.removeListener?.(onStorageChanged);
    } catch {
      // The extension context is already gone.
    }
  }

  // Replace any older bridge in this tab, then take over.
  document.dispatchEvent(new CustomEventCtor(EVENT_REPLACE));
  document.addEventListener(EVENT_ASK, onAsk);
  document.addEventListener(EVENT_PLAY, onPlay);
  document.addEventListener(EVENT_REPLACE, stop);
  chrome.storage.onChanged.addListener(onStorageChanged);

  return { ready: refresh(), stop };
}
