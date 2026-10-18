import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PLAY,
  PAIRING_WINDOW_MS,
  isKnownIncomingSound,
  isWhatsAppSound,
} from "../core/protocol.mjs";

const HOOK_MARKER = Symbol.for("wansc.main-hook");

/**
 * Runs inside WhatsApp's own page (MAIN world), before WhatsApp's scripts.
 *
 *  - Tells the page notification permission is "granted" and swallows the notification, so no
 *    desktop popup appears and the browser permission can stay blocked.
 *  - Remembers which chat the last notification was for, then replaces WhatsApp's own message
 *    sound (its next play() call) with the sound chosen for that chat.
 *
 * Every decision comes from the isolated-world bridge via synchronous DOM events. If the bridge
 * does not answer, the hook does nothing and WhatsApp behaves exactly as it would without us.
 */
export function installMainHook({ window, document, now = () => Date.now() }) {
  // Idempotent: the background may inject this again into a tab that already has it (after the
  // extension is reloaded). Wrapping twice would break the page's Notification.
  const existing = window[HOOK_MARKER];
  if (existing) return existing;

  const OriginalNotification = window.Notification;
  const mediaProto = window.HTMLMediaElement ? window.HTMLMediaElement.prototype : null;
  const originalPlay = mediaProto ? mediaProto.play : null;
  let pending = null;

  /** Opt-in tracing: run `localStorage.wanscDebug = "1"` in the page console, then reload. */
  function debug(...args) {
    try {
      if (window.localStorage?.getItem("wanscDebug")) window.console.debug("[WANSC]", ...args);
    } catch {
      // Storage or console unavailable: tracing is best-effort.
    }
  }

  function dispatch(name, payload) {
    document.dispatchEvent(new window.CustomEvent(name, { detail: JSON.stringify(payload) }));
  }

  /** Synchronous round trip to the bridge. Returns null when nobody answers. */
  function ask(payload) {
    let answer = null;
    const onAnswer = (event) => {
      try {
        answer = JSON.parse(event.detail);
      } catch {
        answer = null;
      }
    };
    document.addEventListener(EVENT_ANSWER, onAnswer);
    try {
      dispatch(EVENT_ASK, payload);
    } catch {
      answer = null;
    } finally {
      document.removeEventListener(EVENT_ANSWER, onAnswer);
    }
    return answer;
  }

  /** An inert stand-in that looks like a Notification to the page but shows nothing. */
  function makeStub(title, options) {
    const o = options || {};
    const stub = Object.create(OriginalNotification.prototype);
    const fields = {
      title: title == null ? "" : String(title),
      body: o.body ?? "",
      tag: o.tag ?? "",
      icon: o.icon ?? "",
      data: o.data ?? null,
      dir: o.dir ?? "auto",
      lang: o.lang ?? "",
      silent: true,
      renotify: Boolean(o.renotify),
      requireInteraction: Boolean(o.requireInteraction),
      badge: "",
      image: "",
      vibrate: [],
      actions: [],
      timestamp: now(),
      onclick: null,
      onclose: null,
      onerror: null,
      onshow: null,
      close() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
    };
    // defineProperty, not assignment: the real prototype has getter-only accessors that would
    // make a plain assignment throw in strict mode.
    for (const [key, value] of Object.entries(fields)) {
      Object.defineProperty(stub, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    return stub;
  }

  const ManagedNotification = function Notification(title, options) {
    if (!new.target) {
      throw new TypeError(
        "Failed to construct 'Notification': Please use the 'new' operator, this DOM object constructor cannot be called as a function."
      );
    }
    const answer = ask({
      kind: "notification",
      title: title == null ? "" : String(title),
      tag: typeof options?.tag === "string" ? options.tag : "",
      body: typeof options?.body === "string" ? options.body : "",
    });

    debug("notification", { title: String(title ?? ""), tag: options?.tag }, "->", answer);
    if (answer?.mode !== "managed") {
      pending = null;
      return new OriginalNotification(title, options);
    }

    pending = { decision: answer.decision, at: now() };
    if (answer.showPopup && OriginalNotification.permission === "granted") {
      return new OriginalNotification(title, { ...(options || {}), silent: true });
    }
    return makeStub(title, options);
  };

  if (OriginalNotification) {
    ManagedNotification.prototype = OriginalNotification.prototype;
    Object.defineProperty(ManagedNotification, "permission", {
      get: () => (ask({ kind: "permission" })?.spoof ? "granted" : OriginalNotification.permission),
      enumerable: true,
      configurable: true,
    });
    ManagedNotification.requestPermission = function requestPermission(callback) {
      if (ask({ kind: "permission" })?.spoof) {
        if (typeof callback === "function") callback("granted");
        return Promise.resolve("granted");
      }
      return OriginalNotification.requestPermission.apply(OriginalNotification, arguments);
    };
    window.Notification = ManagedNotification;
  }

  /** The decision for this sound, or null to leave the sound alone. */
  function takeDecision(url) {
    const paired = pending;
    pending = null;
    if (paired && now() - paired.at <= PAIRING_WINDOW_MS) return paired.decision;
    if (isKnownIncomingSound(url)) return ask({ kind: "default-sound" })?.decision ?? null;
    return null;
  }

  if (mediaProto && typeof originalPlay === "function") {
    mediaProto.play = function play(...args) {
      const url = this.currentSrc || this.src || "";
      if (isWhatsAppSound(url)) {
        const decision = takeDecision(url);
        debug(
          "WhatsApp sound",
          url.split("/").pop(),
          "->",
          decision ?? "left alone (unrecognised)"
        );
        if (decision && decision.action !== "native") {
          if (decision.action === "play") {
            dispatch(EVENT_PLAY, { soundId: decision.soundId, volume: decision.volume });
          }
          return Promise.resolve();
        }
      }
      return originalPlay.apply(this, args);
    };
  }

  const api = {
    uninstall() {
      if (OriginalNotification) window.Notification = OriginalNotification;
      if (mediaProto && originalPlay) mediaProto.play = originalPlay;
      delete window[HOOK_MARKER];
    },
  };
  // A symbol key is skipped by ordinary enumeration (Object.keys, for...in, JSON).
  Object.defineProperty(window, HOOK_MARKER, { value: api, configurable: true });
  return api;
}
