import { parseDataUrl } from "../core/audio-data.mjs";
import { decidePlayback, findRebind } from "../core/matcher.mjs";
import { HEALTH_KEY, applySignal, classifyTag } from "../core/health.mjs";
import { cleanDisplayName, normalizeName } from "../core/normalize.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PING,
  EVENT_PONG,
  EVENT_REPLACE,
  EVENT_SIGNAL,
  EVENT_SOUNDS,
  MSG_GET_SOUND,
  MSG_REBIND,
  MSG_SEEN,
  PAGE_MODEL_KEY,
} from "../core/protocol.mjs";
import { readState } from "../core/state-store.mjs";

// The sound logic follows WhatsApp and never guesses from WhatsApp's page. It reacts only to what
// WhatsApp itself does through browser functions, which the page hook passes on:
//   - WhatsApp raises a notification: it names the chat (tag = the chat's unique id);
//   - WhatsApp plays its message sound: a sound is due now.
// notification            -> that chat's rule (its sound / silent / default / WhatsApp's own);
// sound, no notification  -> your default sound, else WhatsApp's own (no chat is guessed);
// WhatsApp does nothing   -> nothing. Mutes and @mentions therefore behave exactly as in WhatsApp.
//
// The page hook plays the chosen sound itself, in a player created by WhatsApp's page, from the
// sounds this bridge hands it in advance. There is no separate audio player to fail or be late.

const HEALTH_FLUSH_MS = 1000;
const HOOK_CHECK_MS = 30_000;
// A notification title shared by this many different chats is not a chat's name (e.g. WhatsApp
// hiding names): rules are then never tied to a chat by it.
const GENERIC_TITLE_CHATS = 3;

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
  CustomEventCtor = document.defaultView.CustomEvent,
  log = () => {},
}) {
  let state = null;
  let stopped = false;
  let queuedSignals = [];
  let flushTimer = null;
  let checkTimer = null;
  // The sounds in use, and how many the page hook was given (for the self-test).
  let soundsWanted = 0;
  let soundsHanded = 0;
  let handing = 0;
  // Which chat ids each notification title came with, to spot titles that are not chat names.
  const tagsByTitle = new Map();

  // ---------------------------------------------------------------- status record

  /**
   * Record what happened so the popup can say whether things still work. Signals are batched,
   * then folded into the stored health record. Best effort: never allowed to disturb sounds.
   */
  function record(signal) {
    if (queuedSignals.length < 100) queuedSignals.push(signal); // the page can send these too
    if (flushTimer !== null) return;
    flushTimer = globalThis.setTimeout(flush, HEALTH_FLUSH_MS);
    flushTimer?.unref?.();
  }

  async function flush() {
    flushTimer = null;
    const batch = queuedSignals;
    queuedSignals = [];
    if (batch.length === 0 || typeof chrome.storage?.local?.set !== "function") return;
    try {
      const stored = await chrome.storage.local.get([HEALTH_KEY]);
      const at = Date.now();
      const health = batch.reduce(
        (acc, signal) => applySignal(acc, signal, at),
        stored?.[HEALTH_KEY]
      );
      await chrome.storage.local.set({ [HEALTH_KEY]: health });
    } catch {
      // The extension context may be gone; the status line just stays as it was.
    }
  }

  function onSignal(event) {
    const signal = parse(event.detail);
    if (signal && typeof signal === "object") record(signal);
  }

  // ---------------------------------------------------------------- the page hook

  /** Ping the page hook once: "ok", "missing" or "overwritten" (it may put itself back first). */
  function pingHook() {
    let pong = null;
    const onPong = (event) => (pong = parse(event.detail));
    document.addEventListener(EVENT_PONG, onPong);
    try {
      document.dispatchEvent(new CustomEventCtor(EVENT_PING));
    } finally {
      document.removeEventListener(EVENT_PONG, onPong);
    }
    const hook = !pong ? "missing" : pong.notification && pong.play ? "ok" : "overwritten";
    return { state: hook, healed: pong?.healed === true };
  }

  /** Is the page-world hook still installed and still the one WhatsApp calls? */
  function checkHook() {
    const { state: hook, healed } = pingHook();
    log("hook check ->", hook, healed ? "(put back after being replaced)" : "");
    if (healed) record({ type: "hook-healed" });
    record({ type: "hook", state: hook });
  }

  /** After the extension is reloaded or updated, this copy loses its extension APIs. */
  function isOrphaned() {
    try {
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  }

  // ---------------------------------------------------------------- settings and sounds

  async function refresh() {
    try {
      state = await readState(chrome.storage.local);
    } catch {
      // Keep the last good state (e.g. the extension was reloaded under us).
    }
    await handSoundsToPage();
  }

  /** The sounds a rule or the default uses. */
  function soundsInUse() {
    const ids = new Set();
    for (const rule of state?.rules ?? []) {
      if (rule?.enabled && rule.action === "sound" && state.sounds?.[rule.soundId]) {
        ids.add(rule.soundId);
      }
    }
    const fallback = state?.settings?.defaultSoundId;
    if (fallback && state.sounds?.[fallback]) ids.add(fallback);
    return [...ids];
  }

  /**
   * Hand every sound in use to the page hook, which plays them itself. Fetched from the
   * background worker now, never at the moment a message arrives. Sent again on any change.
   */
  async function handSoundsToPage() {
    if (!state) return;
    const mine = ++handing;
    const ids = soundsInUse();
    const sounds = [];
    for (const id of ids) {
      try {
        const response = await chrome.runtime.sendMessage({ type: MSG_GET_SOUND, soundId: id });
        if (response?.ok && typeof response.dataUrl === "string") {
          sounds.push({ id, dataUrl: response.dataUrl });
        }
      } catch {
        // That sound stays with the hook's last copy, or WhatsApp's own plays instead.
      }
    }
    if (mine !== handing || stopped) return; // a newer hand-over is on its way
    soundsWanted = ids.length;
    soundsHanded = sounds.length;
    try {
      document.dispatchEvent(
        new CustomEventCtor(EVENT_SOUNDS, { detail: JSON.stringify({ sounds }) })
      );
      log("handed", sounds.length, "of", ids.length, "sounds to the page");
    } catch {
      // The page hook keeps what it had.
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    // Our own status writes do not change any rule.
    if (Object.keys(changes).every((key) => key === HEALTH_KEY || key === PAGE_MODEL_KEY)) return;
    refresh();
  }

  // ---------------------------------------------------------------- deciding

  /** Fire-and-forget message to the background worker. */
  function send(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // The extension context may be gone; sounds still work from the cached state.
    }
  }

  /** Is this title shared by many chats (so not a chat's name)? Remembers the pairing. */
  function isGenericTitle({ title, tag }) {
    const key = normalizeName(title);
    if (!key || !tag) return false;
    const tags = tagsByTitle.get(key) ?? new Set();
    tags.add(tag);
    tagsByTitle.set(key, tags);
    if (tagsByTitle.size > 500) tagsByTitle.delete(tagsByTitle.keys().next().value);
    return tags.size >= GENERIC_TITLE_CHATS;
  }

  /** Tell the background which chat notified, so the popup can offer it (name and id only). */
  function reportSeen({ title, tag }, generic) {
    const name = cleanDisplayName(title);
    if (!name || generic) return;
    send({
      type: MSG_SEEN,
      items: [
        {
          name,
          kind: "chat",
          ...(tag ? { chatId: tag } : {}),
          ...(classifyTag(tag) === "group" ? { group: true } : {}),
        },
      ],
    });
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
        const generic = isGenericTitle(notification);
        reportSeen(notification, generic);
        record({ type: "notification", tag: notification.tag });
        record({ type: "titles", generic });
        const decision = decidePlayback({ notification, rules, sounds, settings });
        // A rule made from a name (Refresh chat list) is tied to the chat's id here, once.
        const bind = generic ? null : findRebind(notification, rules);
        if (bind) send({ type: MSG_REBIND, ...bind });
        log("decision for chat", notification.tag || notification.title, "->", decision);
        return { mode: "managed", decision, showPopup: settings.showPopups };
      }

      case "default-sound": {
        // WhatsApp's sound with no notification (it is focused): no chat is named, so no chat
        // is guessed. Your default sound, else WhatsApp's own.
        if (!settings.enabled) return { decision: { action: "native" } };
        const decision = decidePlayback({ notification: {}, rules, sounds, settings });
        log("WhatsApp's sound with no notification ->", decision);
        return { decision };
      }

      default:
        return null;
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

  // ---------------------------------------------------------------- lifecycle

  function stop() {
    if (stopped) return;
    stopped = true;
    document.removeEventListener(EVENT_ASK, onAsk);
    document.removeEventListener(EVENT_REPLACE, stop);
    document.removeEventListener(EVENT_SIGNAL, onSignal);
    globalThis.clearInterval(checkTimer);
    globalThis.clearTimeout(flushTimer);
    try {
      chrome.storage.onChanged.removeListener?.(onStorageChanged);
    } catch {
      // The extension context is already gone.
    }
  }

  // Replace any older bridge in this tab, then take over.
  document.dispatchEvent(new CustomEventCtor(EVENT_REPLACE));
  document.addEventListener(EVENT_ASK, onAsk);
  document.addEventListener(EVENT_REPLACE, stop);
  document.addEventListener(EVENT_SIGNAL, onSignal);
  chrome.storage.onChanged.addListener(onStorageChanged);

  // WhatsApp could replace our wrappers later, so check now and then. A check is one DOM event.
  checkHook();
  checkTimer = globalThis.setInterval(() => {
    if (!isOrphaned()) checkHook();
  }, HOOK_CHECK_MS);
  checkTimer?.unref?.();

  /** Something the content script checked. */
  function report(signal) {
    if (signal && typeof signal === "object" && !stopped) record(signal);
  }

  return {
    ready: refresh(),
    stop,
    report,
    // For the self-test (self-test.mjs).
    hookState: () => pingHook().state,
    settings: () => state?.settings ?? null,
    soundsReady: () => soundsHanded >= soundsWanted,
  };
}
