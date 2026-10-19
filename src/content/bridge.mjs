import { parseDataUrl } from "../core/audio-data.mjs";
import {
  decideForChatName,
  decidePlayback,
  findRebind,
  parseSenderFromBody,
} from "../core/matcher.mjs";
import { createChatIdentity } from "../core/chat-identity.mjs";
import { HEALTH_KEY, applySignal, classifyTag } from "../core/health.mjs";
import { cleanDisplayName, normalizeName } from "../core/normalize.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PING,
  EVENT_PLAY,
  EVENT_PLAY_NATIVE,
  EVENT_PONG,
  EVENT_REPLACE,
  EVENT_SIGNAL,
  MSG_GET_SOUND,
  MSG_REBIND,
  MSG_SEEN,
  PAGE_MODEL_KEY,
} from "../core/protocol.mjs";
import { readState } from "../core/state-store.mjs";

const HEALTH_FLUSH_MS = 1000;
const HOOK_CHECK_MS = 30_000;
// A new message seen in the chat list waits this long for WhatsApp's own notification or sound;
// if either came within WHATSAPP_ACTIVITY_MS of it, that path already handled the message.
const INCOMING_WAIT_MS = 700;
const WHATSAPP_ACTIVITY_MS = 2000;
// While focused, WhatsApp's own sound (Edge) is held this long for the chat to be identified
// from its unread counter; if none is, what was held plays after all.
const HOLD_MS = 1500;

function defaultIsFocused(document) {
  try {
    return document.visibilityState === "visible" && document.hasFocus();
  } catch {
    return false;
  }
}
// Chat-id kinds that are always one-to-one chats (see classifyTag).
const ONE_TO_ONE = ["lid", "phone"];

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
  log = () => {},
  // Told { title, tag } for every notification WhatsApp raises (never the message), so the
  // content script can learn the page and which chats are muted.
  onNotification = () => {},
  isFocused = () => defaultIsFocused(document),
}) {
  let state = null;
  let lastWhatsAppActivityAt = -Infinity;
  // The chat id last seen with each chat name, and every name seen this session.
  const lastIdForName = new Map();
  const titlesSeen = new Set();
  const incomingTimers = new Set();
  let held = null;
  let identity = null;
  /** Groups, generic titles and missing senders, judged by behaviour (chat-identity.mjs). */
  function chatIdentity() {
    if (!identity) {
      const groups = (state?.recentSenders ?? [])
        .filter((s) => s?.group === true && typeof s.chatId === "string")
        .map((s) => s.chatId);
      identity = createChatIdentity({ groups });
    }
    return identity;
  } // WhatsApp's focused-mode sound, held back until the chat is known
  let queuedSignals = [];
  let flushTimer = null;
  let checkTimer = null;

  /**
   * Record what happened to WhatsApp's sound so the popup can say whether things still work.
   * Signals are batched, then folded into the stored health record (read-modify-write, so
   * several WhatsApp tabs add to the same record). Best effort: never allowed to disturb sounds.
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

  /** Is the page-world hook still installed and still the one WhatsApp calls? */
  function checkHook() {
    let pong = null;
    const onPong = (event) => (pong = parse(event.detail));
    document.addEventListener(EVENT_PONG, onPong);
    try {
      document.dispatchEvent(new CustomEventCtor(EVENT_PING));
    } finally {
      document.removeEventListener(EVENT_PONG, onPong);
    }
    const state = !pong ? "missing" : pong.notification && pong.play ? "ok" : "overwritten";
    log("hook check ->", state);
    record({ type: "hook", state });
  }

  function onSignal(event) {
    const signal = parse(event.detail);
    if (signal && typeof signal === "object") record(signal);
  }

  async function refresh() {
    try {
      state = await readState(chrome.storage.local);
    } catch {
      // Keep the last good state (e.g. the extension was reloaded under us).
    }
  }

  /** Tell the background which chats we saw, so the options page can offer them. Names only. */
  function reportSeen({ title, tag, body }, seen) {
    const items = [];
    const name = cleanDisplayName(title);
    // A title shared by many chats is not a chat's name: do not record it as one.
    if (name && !seen.titlesGeneric) {
      items.push({
        name,
        kind: "chat",
        ...(tag ? { chatId: tag } : {}),
        ...(seen.isGroup ? { group: true } : {}),
      });
    }
    // Groups put "Sender: text" in the body. One-to-one chats never do ("Note: ..." is just a
    // message), so only known 1:1 ids are excluded, unless the chat was recognised as a group by
    // its behaviour: a group id format WhatsApp introduces later still has its senders collected.
    if (seen.isGroup || !ONE_TO_ONE.includes(classifyTag(tag))) {
      const sender = cleanDisplayName(parseSenderFromBody(body));
      if (sender && normalizeName(sender) !== normalizeName(name)) {
        items.push({ name: sender, kind: "sender" });
      }
    }
    if (items.length === 0) return;
    send({ type: MSG_SEEN, items });
  }

  /** Fire-and-forget message to the background worker. */
  function send(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // The extension context may be gone; sounds still work from the cached state.
    }
  }

  /**
   * Muting WhatsApp's sound only makes sense if ours can start. While the browser still blocks
   * audio (no click in the tab yet), keep WhatsApp's own sound rather than leave silence.
   */
  function playable(decision) {
    if (decision?.action !== "play" || typeof engine.canPlay !== "function") return decision;
    if (engine.canPlay()) return decision;
    log("our sound can't start yet (browser blocks audio) -> WhatsApp's own sound");
    record({ type: "play-blocked" });
    return { action: "native" };
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
        const seen = chatIdentity().observe(notification);
        reportSeen(notification, seen);
        record({ type: "notification", tag: notification.tag });
        record({ type: "titles", generic: seen.titlesGeneric });
        if (seen.isGroup) record({ type: "group-sender", ok: Boolean(seen.sender) });
        // With generic titles a notification no longer says which chat it is: learn nothing
        // from it (it would teach wrong names and make every chat look muted).
        if (!seen.titlesGeneric) noteNotification(notification);
        const decision = playable(decidePlayback({ notification, rules, sounds, settings }));
        const rebind = seen.titlesGeneric ? null : findRebind(notification, rules);
        if (rebind) send({ type: MSG_REBIND, ...rebind });
        log("decision for chat", notification.tag || notification.title, "->", decision);
        return { mode: "managed", decision, showPopup: settings.showPopups };
      }

      case "default-sound":
        if (!settings.enabled) return { decision: { action: "native" } };
        if (shouldHold()) {
          hold();
          log("WhatsApp's sound while focused: held until the chat is known");
          return { decision: { action: "silent" } };
        }
        lastWhatsAppActivityAt = Date.now();
        {
          const decision = playable(decidePlayback({ notification: {}, rules, sounds, settings }));
          log("sound with no notification (tab focused?) ->", decision);
          return { decision };
        }

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
    if (question.kind === "notification") lastWhatsAppActivityAt = Date.now();
    const answer = answerFor(question);
    if (answer) {
      document.dispatchEvent(new CustomEventCtor(EVENT_ANSWER, { detail: JSON.stringify(answer) }));
    }
  }

  function onPlay(event) {
    if (isOrphaned()) return stop();
    const request = parse(event.detail);
    if (!request || typeof request.soundId !== "string") return;
    Promise.resolve(engine.play(request.soundId, request.volume)).then((started) => {
      log("playback of", request.soundId, started ? "started" : "FAILED (see [WANSC] error above)");
      record({ type: started ? "played" : "play-failed" });
    });
  }

  /**
   * A new message seen in the chat list while WhatsApp is focused. Some browsers' WhatsApp makes
   * no notification and no sound then; if WhatsApp did neither, play the chat's sound ourselves.
   */
  function onIncomingChat(name) {
    if (stopped || typeof name !== "string" || !name) return;
    // WhatsApp already made its sound and we held it: this is the chat it was for.
    if (takeHold()) return playForChat(name);
    const seenAt = Date.now();
    const timer = globalThis.setTimeout(() => {
      incomingTimers.delete(timer);
      if (stopped || !state || isOrphaned()) return;
      if (takeHold()) return playForChat(name);
      if (Math.abs(lastWhatsAppActivityAt - seenAt) < WHATSAPP_ACTIVITY_MS) return; // handled
      playForChat(name);
    }, INCOMING_WAIT_MS);
    incomingTimers.add(timer);
  }

  /** The chat's sound, else the default sound, else WhatsApp's own ding. Never for silent chats. */
  function playForChat(name) {
    if (stopped || !state) return;
    const { settings, rules, sounds } = state;
    const preferChatId = lastIdForName.get(normalizeName(name)) ?? null;
    const decision = decideForChatName({ name, rules, sounds, settings, preferChatId });
    log("new message in", name, "while focused ->", decision);
    playDecision(decision);
  }

  function playDecision(decision) {
    if (decision?.action === "native") return playWhatsAppDing();
    if (decision?.action !== "play") return;
    if (typeof engine.canPlay === "function" && !engine.canPlay()) {
      log("our sound can't start yet (browser blocks audio until you click in WhatsApp)");
      record({ type: "play-blocked" });
      return;
    }
    Promise.resolve(engine.play(decision.soundId, decision.volume)).then((started) => {
      log(
        "playback of",
        decision.soundId,
        started ? "started" : "FAILED (see [WANSC] error above)"
      );
      record({ type: started ? "played" : "play-failed" });
      if (started) record({ type: "self-played" });
    });
  }

  /** WhatsApp's own incoming sound, played by the page hook as WhatsApp would. */
  function playWhatsAppDing() {
    try {
      document.dispatchEvent(new CustomEventCtor(EVENT_PLAY_NATIVE));
      log("playing WhatsApp's own sound (no sound of yours for this chat)");
      record({ type: "self-played" });
    } catch {
      // Nothing more to do.
    }
  }

  /** Hold WhatsApp's focused-mode sound only when ours can certainly play instead. */
  function shouldHold() {
    try {
      if (!isFocused()) return false;
    } catch {
      return false;
    }
    return typeof engine.canPlay !== "function" || engine.canPlay();
  }

  function hold() {
    if (held) globalThis.clearTimeout(held.timer);
    const mine = { timer: null };
    mine.timer = globalThis.setTimeout(() => {
      if (held !== mine) return;
      held = null;
      // No chat turned up (e.g. the message is in the open chat): play what was held.
      if (stopped || !state) return;
      const { settings, rules, sounds } = state;
      playDecision(decidePlayback({ notification: {}, rules, sounds, settings }));
    }, HOLD_MS);
    held = mine;
  }

  function takeHold() {
    if (!held) return false;
    globalThis.clearTimeout(held.timer);
    held = null;
    return true;
  }

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    // Our own status and learning writes do not change any rule.
    if (Object.keys(changes).every((key) => key === HEALTH_KEY || key === PAGE_MODEL_KEY)) return;
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
    document.removeEventListener(EVENT_SIGNAL, onSignal);
    globalThis.clearInterval(checkTimer);
    for (const timer of incomingTimers) globalThis.clearTimeout(timer);
    if (held) globalThis.clearTimeout(held.timer);
    held = null;
    incomingTimers.clear();
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
  document.addEventListener(EVENT_PLAY, onPlay);
  document.addEventListener(EVENT_REPLACE, stop);
  document.addEventListener(EVENT_SIGNAL, onSignal);
  chrome.storage.onChanged.addListener(onStorageChanged);

  // WhatsApp could replace our wrappers later, so check now and then. A check is one DOM event.
  checkHook();
  checkTimer = globalThis.setInterval(() => {
    if (!isOrphaned()) checkHook();
  }, HOOK_CHECK_MS);
  checkTimer?.unref?.();

  function noteNotification({ title, tag }) {
    const name = cleanDisplayName(title);
    if (!name) return;
    titlesSeen.add(name);
    if (tag) lastIdForName.set(normalizeName(name), tag);
    try {
      onNotification({ title: name, tag });
    } catch {
      // Learning must never disturb the sound.
    }
  }

  /** Every chat name the extension knows: rules, saved chats, recent chats, this session. */
  function knownChatNames() {
    const names = new Set(titlesSeen);
    for (const rule of state?.rules ?? []) {
      if (rule?.kind === "chat" && typeof rule.match === "string") names.add(rule.match);
    }
    for (const chat of state?.knownChats ?? []) if (chat?.name) names.add(chat.name);
    for (const sender of state?.recentSenders ?? []) {
      if (sender?.kind === "chat" && sender.name) names.add(sender.name);
    }
    return [...names];
  }

  /** Something the content script checked (e.g. whether the chat list is readable). */
  function report(signal) {
    if (signal && typeof signal === "object" && !stopped) record(signal);
  }

  return { ready: refresh(), stop, onIncomingChat, knownChatNames, report };
}
