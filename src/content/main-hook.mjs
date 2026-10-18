import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PING,
  EVENT_PLAY,
  EVENT_PONG,
  EVENT_SIGNAL,
  NO_SOUND_WINDOW_MS,
  PAIRING_WINDOW_MS,
  SELF_PLAY_MS,
  isKnownIncomingSound,
  isWhatsAppSound,
  soundFileName,
} from "../core/protocol.mjs";

const HOOK_MARKER = Symbol.for("wansc.main-hook");
const LEARNED_KEY = "wanscLearnedSounds";
const MAX_LEARNED = 5;
// Web Audio is only watched once the normal <audio> route has demonstrably stopped producing
// sounds (this many notifications in a row with none), or has already been seen to work.
const WEB_AUDIO_AFTER_SILENT = 2;

/**
 * Runs inside WhatsApp's own page (MAIN world), before WhatsApp's scripts.
 *
 *  - Tells the page notification permission is "granted" and swallows the notification, so no
 *    desktop popup appears and the browser permission can stay blocked.
 *  - Remembers which chat the last notification was for, then replaces WhatsApp's own message
 *    sound (its next play() call) with the sound chosen for that chat.
 *
 * WhatsApp is not an API and changes without notice, so this is built to bend rather than break:
 * the sound is recognised by what it does (it follows a notification) and not only by its file
 * name; a renamed file is learned; Web Audio and service-worker notifications are covered as
 * fallbacks; and every decision fails open. Anything unexpected leaves WhatsApp exactly as it
 * would behave without us.
 *
 * Every decision comes from the isolated-world bridge via synchronous DOM events. If the bridge
 * does not answer, the hook does nothing.
 */
export function installMainHook({ window, document, now = () => Date.now() }) {
  // Idempotent: the background may inject this again into a tab that already has it (after the
  // extension is reloaded). Wrapping twice would break the page's Notification.
  const existing = window[HOOK_MARKER];
  if (existing) return existing;

  const OriginalNotification = window.Notification;
  const mediaProto = window.HTMLMediaElement ? window.HTMLMediaElement.prototype : null;
  const originalPlay = mediaProto ? mediaProto.play : null;
  const registrationProto = window.ServiceWorkerRegistration?.prototype ?? null;
  const originalShow = registrationProto?.showNotification ?? null;
  const sourceProto = window.AudioBufferSourceNode?.prototype ?? null;
  const originalStart = sourceProto?.start ?? null;
  const permissions = window.navigator?.permissions ?? null;
  const originalQuery = typeof permissions?.query === "function" ? permissions.query : null;
  const queryWasOwn =
    originalQuery !== null && Object.prototype.hasOwnProperty.call(permissions, "query");

  let pending = null;
  let silentRun = 0;
  let webAudioProven = false;
  let learnedCache = null;

  /** Opt-in tracing: run `localStorage.wanscDebug = "1"` in the page console, then reload. */
  function debug(...args) {
    try {
      if (window.localStorage?.getItem("wanscDebug")) window.console.debug("[WANSC]", ...args);
    } catch {
      // Storage or console unavailable: tracing is best-effort.
    }
  }

  function schedule(fn, ms) {
    const handle = window.setTimeout
      ? window.setTimeout.call(window, fn, ms)
      : globalThis.setTimeout(fn, ms);
    handle?.unref?.();
    return handle;
  }

  function cancel(handle) {
    if (handle == null) return;
    (window.clearTimeout ?? globalThis.clearTimeout).call(window, handle);
  }

  function dispatch(name, payload) {
    document.dispatchEvent(new window.CustomEvent(name, { detail: JSON.stringify(payload) }));
  }

  /** Tell the bridge what happened, for the status line. Never allowed to break the page. */
  function signal(payload) {
    try {
      dispatch(EVENT_SIGNAL, payload);
    } catch {
      // The status line is a nicety.
    }
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

  // ---------------------------------------------------------------- pairing

  function clearPending() {
    if (pending) {
      cancel(pending.timer);
      cancel(pending.selfTimer);
    }
    pending = null;
  }

  function setPending(decision, { selfPlay = false } = {}) {
    clearPending();
    const mine = { decision, at: now(), timer: null, selfTimer: null, selfPlayed: false };
    // A notification WhatsApp did not mark silent would have made the operating system ring
    // (we hid it). If WhatsApp plays no sound of its own, play the chat's sound ourselves.
    if (selfPlay && decision?.action === "play") {
      mine.selfTimer = schedule(() => {
        if (pending !== mine) return;
        mine.selfPlayed = true;
        silentRun = 0;
        debug("no sound from WhatsApp; playing the chat's sound ourselves");
        try {
          dispatch(EVENT_PLAY, { soundId: decision.soundId, volume: decision.volume });
        } catch {
          // Nothing more to do.
        }
        signal({ type: "self-played" });
      }, SELF_PLAY_MS);
    }
    // If no sound follows, remember it: several in a row means WhatsApp changed (or its own
    // sounds are off), which the status line reports.
    mine.timer = schedule(() => {
      if (pending !== mine) return;
      pending = null;
      if (mine.selfPlayed) return;
      silentRun += 1;
      signal({ type: "silent" });
    }, NO_SOUND_WINDOW_MS);
    pending = mine;
  }

  /** The tab is hidden or its window is not focused: WhatsApp notifies for every message then. */
  function inBackground() {
    try {
      if (document.visibilityState === "hidden") return true;
      return typeof document.hasFocus === "function" ? !document.hasFocus() : false;
    } catch {
      return false;
    }
  }

  /** The notification a sound arriving now would belong to, or null. Does not consume it. */
  function freshPending() {
    return pending && now() - pending.at <= PAIRING_WINDOW_MS ? pending : null;
  }

  // ---------------------------------------------------------------- learned sound files

  function learnedFiles() {
    if (learnedCache === null) {
      learnedCache = [];
      try {
        const stored = JSON.parse(window.localStorage?.getItem(LEARNED_KEY) || "[]");
        if (Array.isArray(stored)) {
          learnedCache = stored.filter((f) => typeof f === "string").slice(-MAX_LEARNED);
        }
      } catch {
        // Unreadable storage: start with nothing learned.
      }
    }
    return learnedCache;
  }

  /** A sound that played right after a notification is the incoming-message sound: remember it. */
  function learn(url) {
    if (!isWhatsAppSound(url)) return;
    const file = soundFileName(url);
    const files = learnedFiles();
    if (!file || files.includes(file)) return;
    files.push(file);
    if (files.length > MAX_LEARNED) files.shift();
    try {
      window.localStorage?.setItem(LEARNED_KEY, JSON.stringify(files));
    } catch {
      // Not persisted: it is learned again next time.
    }
  }

  // ---------------------------------------------------------------- notifications

  /**
   * A stand-in that looks and behaves like a Notification to the page but shows nothing. Like a
   * real one it fires "show" just after it is created and "close" when closed, in case WhatsApp
   * ever waits for those events.
   */
  function makeStub(title, options) {
    const o = options || {};
    const stub = Object.create(OriginalNotification.prototype);
    const listeners = new Map(); // type -> Set of listeners
    let closed = false;

    function fire(event) {
      const handlers = [stub[`on${event.type}`], ...(listeners.get(event.type) ?? [])];
      for (const handler of handlers) {
        try {
          if (typeof handler === "function") handler.call(stub, event);
          else if (typeof handler?.handleEvent === "function") handler.handleEvent(event);
        } catch {
          // A page handler that throws must not stop the others.
        }
      }
      return true;
    }
    const eventOf = (type) => ({ type, target: stub, currentTarget: stub });

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
      close() {
        if (closed) return;
        closed = true;
        fire(eventOf("close"));
      },
      addEventListener(type, listener) {
        if (!listener) return;
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent(event) {
        return event?.type ? fire({ ...eventOf(event.type), ...event }) : true;
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
    // Never synchronously: the page attaches its handlers right after `new Notification()`.
    schedule(() => {
      if (!closed) fire(eventOf("show"));
    }, 0);
    return stub;
  }

  /**
   * Ask the bridge about a notification the page is raising. Returns the answer when we manage
   * it (and starts waiting for its sound), or null when it should go through untouched.
   */
  function consult(title, options) {
    const answer = ask({
      kind: "notification",
      title: title == null ? "" : String(title),
      tag: typeof options?.tag === "string" ? options.tag : "",
      body: typeof options?.body === "string" ? options.body : "",
    });

    debug("notification", { title: String(title ?? ""), tag: options?.tag }, "->", answer);
    if (answer?.mode !== "managed") {
      clearPending();
      return null;
    }
    // Today WhatsApp passes silent:true and plays its own sound; anything else means the
    // operating system was meant to make the sound.
    setPending(answer.decision, { selfPlay: options?.silent !== true });
    return answer;
  }

  const ManagedNotification = function Notification(title, options) {
    if (!new.target) {
      throw new TypeError(
        "Failed to construct 'Notification': Please use the 'new' operator, this DOM object constructor cannot be called as a function."
      );
    }
    let answer = null;
    try {
      answer = consult(title, options);
    } catch {
      answer = null; // fail open
    }
    if (!answer) return new OriginalNotification(title, options);

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

  // If WhatsApp moves to registration.showNotification(), it is handled the same way. (A
  // notification raised by its own service worker, from a push, never reaches the page.)
  const wrappedShow =
    typeof originalShow === "function"
      ? function showNotification(title, options) {
          let answer = null;
          try {
            answer = consult(title, options);
          } catch {
            answer = null; // fail open
          }
          if (!answer) return originalShow.apply(this, arguments);
          if (answer.showPopup) {
            return originalShow.call(this, title, { ...(options || {}), silent: true });
          }
          return Promise.resolve();
        }
      : null;
  if (wrappedShow) registrationProto.showNotification = wrappedShow;

  // ---------------------------------------------------------------- sounds

  /** The decision for a WhatsApp sound, or null to leave it alone. */
  function takeDecision(url, meta) {
    const paired = freshPending();
    clearPending();
    if (paired?.selfPlayed) return { action: "silent" }; // we already played this one
    if (paired) {
      learn(url);
      silentRun = 0;
      signal({ type: "paired", url, ...meta });
      return paired.decision;
    }
    if (isKnownIncomingSound(url, learnedFiles())) {
      const decision = ask({ kind: "default-sound" })?.decision ?? null;
      if (decision) signal({ type: "unpaired", url, ...meta, background: inBackground() });
      return decision;
    }
    return null;
  }

  /** Whether this media element is the incoming-message sound, and what to do about it. */
  function decideForElement(element, url) {
    const detached = element.isConnected === false;
    // A WhatsApp-hosted sound is recognised by where it comes from. If the host or file type
    // ever changes, a sound played by a detached element right after a notification still is:
    // notification sounds are made with `new Audio()`, while voice messages and videos live in
    // the page and blob/data URLs are the user's own media.
    const local = /^(blob|data):/.test(url);
    const looksLikeIt = isWhatsAppSound(url) || (freshPending() !== null && detached && !local);
    if (!looksLikeIt) return { looksLikeIt: false, decision: null };
    return { looksLikeIt: true, decision: takeDecision(url, { via: "audio", detached }) };
  }

  const wrappedPlay =
    mediaProto && typeof originalPlay === "function"
      ? function play(...args) {
          let decision = null;
          try {
            const url = this.currentSrc || this.src || "";
            const result = decideForElement(this, url);
            decision = result.decision;
            if (result.looksLikeIt) {
              debug(
                "WhatsApp sound",
                url.split("/").pop(),
                "->",
                decision ?? "left alone (unrecognised)"
              );
            }
          } catch {
            decision = null; // fail open
          }
          if (decision && decision.action !== "native") {
            try {
              if (decision.action === "play") {
                dispatch(EVENT_PLAY, { soundId: decision.soundId, volume: decision.volume });
              }
            } catch {
              // Nothing more to do: the original sound is still suppressed.
            }
            return Promise.resolve();
          }
          return originalPlay.apply(this, args);
        }
      : null;
  if (wrappedPlay) mediaProto.play = wrappedPlay;

  // Fallback for a WhatsApp that plays its sound through Web Audio instead of an <audio> element.
  const wrappedStart =
    sourceProto && typeof originalStart === "function"
      ? function start(...args) {
          let decision = null;
          try {
            const watching = silentRun >= WEB_AUDIO_AFTER_SILENT || webAudioProven;
            const paired = watching ? freshPending() : null;
            if (paired?.selfPlayed) {
              clearPending();
              decision = { action: "silent" }; // we already played this one
            } else if (paired) {
              clearPending();
              webAudioProven = true;
              silentRun = 0;
              debug("Web Audio sound after a notification ->", paired.decision);
              signal({ type: "paired", url: "", via: "webaudio", detached: false });
              decision = paired.decision;
            }
          } catch {
            decision = null; // fail open
          }
          if (decision && decision.action !== "native") {
            try {
              if (decision.action === "play") {
                dispatch(EVENT_PLAY, { soundId: decision.soundId, volume: decision.volume });
              }
            } catch {
              // Nothing more to do: the original sound is still suppressed.
            }
            return undefined;
          }
          return originalStart.apply(this, args);
        }
      : null;
  if (wrappedStart) sourceProto.start = wrappedStart;

  // ---------------------------------------------------------------- permissions API

  /** A stand-in PermissionStatus that says "granted" and never changes. */
  function grantedStatus(name) {
    const proto = window.PermissionStatus?.prototype ?? Object.prototype;
    const status = Object.create(proto);
    const fields = {
      name,
      state: "granted",
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
    };
    for (const [key, value] of Object.entries(fields)) {
      Object.defineProperty(status, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    return status;
  }

  // WhatsApp reads Notification.permission today. If it switches to the Permissions API, it must
  // hear the same answer, or it stops raising the notifications that say which chat wrote.
  const wrappedQuery = originalQuery
    ? function query(descriptor) {
        try {
          if (descriptor?.name === "notifications" && ask({ kind: "permission" })?.spoof) {
            return Promise.resolve(grantedStatus("notifications"));
          }
        } catch {
          // fail open
        }
        return originalQuery.apply(this, arguments);
      }
    : null;
  if (wrappedQuery) {
    try {
      permissions.query = wrappedQuery;
    } catch {
      // A browser that refuses the override keeps its own answer.
    }
  }

  // ---------------------------------------------------------------- self-check

  /** The bridge asks "are you still in place?" because WhatsApp could replace our wrappers. */
  function onPing() {
    try {
      dispatch(EVENT_PONG, {
        notification: !OriginalNotification || window.Notification === ManagedNotification,
        play: !wrappedPlay || mediaProto.play === wrappedPlay,
      });
    } catch {
      // Not answering is itself reported by the bridge.
    }
  }
  document.addEventListener(EVENT_PING, onPing);

  const api = {
    uninstall() {
      clearPending();
      document.removeEventListener(EVENT_PING, onPing);
      if (OriginalNotification) window.Notification = OriginalNotification;
      if (wrappedPlay) mediaProto.play = originalPlay;
      if (wrappedShow) registrationProto.showNotification = originalShow;
      if (wrappedStart) sourceProto.start = originalStart;
      if (wrappedQuery && permissions.query === wrappedQuery) {
        if (queryWasOwn) permissions.query = originalQuery;
        else delete permissions.query;
      }
      delete window[HOOK_MARKER];
    },
  };
  // A symbol key is skipped by ordinary enumeration (Object.keys, for...in, JSON).
  Object.defineProperty(window, HOOK_MARKER, { value: api, configurable: true });
  return api;
}
