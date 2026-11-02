import { parseDataUrl } from "../core/audio-data.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PING,
  EVENT_PLAY,
  EVENT_PLAY_NATIVE,
  EVENT_QUIET,
  EVENT_SOUNDS,
  EVENT_PONG,
  EVENT_SIGNAL,
  NO_SOUND_WINDOW_MS,
  KNOWN_INCOMING_SOUND_URL,
  PAIRING_WINDOW_MS,
  SELF_PLAY_MS,
  isKnownIncomingSound,
  isWhatsAppSound,
  soundFileName,
} from "../core/protocol.mjs";

const HOOK_MARKER = Symbol.for("wansc.main-hook");
// Raised whenever the hook changes. After an update the background injects the new hook into open
// WhatsApp tabs: an older hook found there is uninstalled first, so old and new code never mix.
export const HOOK_VERSION = 3;
const LEARNED_KEY = "wanscLearnedSounds";
const SOUND_URL_KEY = "wanscSoundUrl";
// How long WhatsApp took to play its sound after a notification, measured (kept across reloads).
const TIMING_KEY = "wanscTiming";
const MAX_SAMPLES = 10;
const MAX_DELAY_MS = 5000;
// However slow WhatsApp gets, a sound more than this long after a notification is not paired.
const MAX_PAIRING_MS = 2000;
const MAX_SELF_PLAY_MS = 1000;
// A known incoming sound this soon after a notification it missed is that notification's, late.
const LATE_LOOKBACK_MS = 3000;
const PERMISSION_CACHE_MS = 1000;
// The longest the bridge may ask WhatsApp's own sound to stay quiet after one of ours.
const MAX_QUIET_MS = 3000;
const MAX_LEARNED = 5;
// A WhatsApp sound is learned as "the incoming sound" only after following a notification this
// many times: once could be another WhatsApp sound (e.g. "message sent" when replying quickly).
const LEARN_CONFIRMATIONS = 2;
const LEARNED_FORMAT = 2;
const MAX_LEARNING = 20;
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
  if (existing?.version === HOOK_VERSION) return existing;
  if (existing) {
    try {
      existing.uninstall?.();
    } catch {
      // An old hook that cannot uninstall: ours wraps whatever is there now.
    }
    try {
      delete window[HOOK_MARKER];
    } catch {
      // Not deletable: overwritten below.
    }
  }

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

  // What our wrappers call through to. It starts as the browser's own, and becomes whatever
  // replaced our wrapper if WhatsApp (or another extension) did, once we put ourselves back on top.
  let targetNotification = OriginalNotification;
  let targetPlay = originalPlay;
  // A replacement that itself calls the one it replaced (ours) would loop: one level deep, the
  // wrappers call the browser's own instead.
  let insideNotification = false;
  let insidePlay = false;

  // Until when WhatsApp's own incoming sound is kept quiet, because we just played one of ours.
  let quietUntil = -Infinity;
  let pending = null;
  // The last notification, kept a little longer than `pending`: a WhatsApp sound arriving later
  // than the pairing window still belongs to it, if no sound has claimed it yet.
  let recent = null;
  let silentRun = 0;
  let webAudioProven = false;
  let learnedCache = null;
  let delays = null;
  let lastNotificationAt = -Infinity;

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

  function setPending(decision, { selfPlay = false, chat = "" } = {}) {
    clearPending();
    const mine = {
      decision,
      at: now(),
      timer: null,
      selfTimer: null,
      selfPlayed: false,
      claimed: false,
      chat,
    };
    lastNotificationAt = mine.at;
    recent = mine;
    // A notification WhatsApp did not mark silent would have made the operating system ring
    // (we hid it). If WhatsApp plays no sound of its own, play the chat's sound ourselves.
    if (selfPlay && decision?.action === "play") {
      mine.selfTimer = schedule(() => {
        if (pending !== mine) return;
        mine.selfPlayed = true;
        silentRun = 0;
        debug("no sound from WhatsApp; playing the chat's sound ourselves");
        if (!playOwn(decision)) onPlayNative(); // not handed over: WhatsApp's own ding
        signal({ type: "self-played" });
      }, selfPlayDelay());
    }
    // If no sound follows, remember it: several in a row means WhatsApp changed (or its own
    // sounds are off), which the status line reports.
    mine.timer = schedule(
      () => {
        if (pending !== mine) return;
        pending = null;
        if (mine.selfPlayed) return;
        silentRun += 1;
        signal({ type: "silent" });
      },
      Math.max(NO_SOUND_WINDOW_MS, pairingWindow() + 500)
    );
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

  /** A decision tagged with the chat it is for, so the bridge's sound gate can tell messages apart. */
  function forChat(decision, chat) {
    return decision && typeof decision === "object" ? { ...decision, chat: chat || "" } : decision;
  }

  /** The last notification, if no sound has claimed it and it is recent enough for a slow sound. */
  function lateNotification() {
    return recent && !recent.claimed && now() - recent.at <= LATE_LOOKBACK_MS ? recent : null;
  }

  /** The notification a sound arriving now would belong to, or null. Does not consume it. */
  function freshPending() {
    return pending && now() - pending.at <= pairingWindow() ? pending : null;
  }

  // ---------------------------------------------------------------- adaptive timing

  function timingSamples() {
    if (delays === null) {
      delays = [];
      try {
        const stored = JSON.parse(window.localStorage?.getItem(TIMING_KEY) || "[]");
        if (Array.isArray(stored)) {
          delays = stored
            .filter((n) => Number.isFinite(n) && n >= 0 && n <= MAX_DELAY_MS)
            .slice(-MAX_SAMPLES);
        }
      } catch {
        // Unreadable: start from the measured defaults.
      }
    }
    return delays;
  }

  function recordDelay(ms) {
    const delay = Math.round(ms);
    if (!(delay >= 0 && delay <= MAX_DELAY_MS)) return;
    const samples = timingSamples();
    samples.push(delay);
    if (samples.length > MAX_SAMPLES) samples.shift();
    try {
      window.localStorage?.setItem(TIMING_KEY, JSON.stringify(samples));
    } catch {
      // Kept for this page only.
    }
    signal({ type: "timing", delay });
  }

  const slowest = () => Math.max(0, ...timingSamples());

  /** How long after a notification its sound is still expected: 3x the slowest seen, 0.5-2 s. */
  function pairingWindow() {
    return Math.min(MAX_PAIRING_MS, Math.max(PAIRING_WINDOW_MS, slowest() * 3));
  }

  /** How long to wait for WhatsApp's own sound before playing ours: 2x the slowest seen. */
  function selfPlayDelay() {
    return Math.min(MAX_SELF_PLAY_MS, Math.max(SELF_PLAY_MS, slowest() * 2 + 50));
  }

  // ---------------------------------------------------------------- learned sound files

  /**
   * What was learned about WhatsApp's incoming sound: `trusted` files (confirmed enough times)
   * and `seen` counts for files still being confirmed. Files saved by the old one-time rule are
   * dropped: one of them could be WhatsApp's "message sent" sound.
   */
  function learnedData() {
    if (learnedCache === null) {
      learnedCache = { trusted: [], seen: {} };
      try {
        const stored = JSON.parse(window.localStorage?.getItem(LEARNED_KEY) || "null");
        if (stored?.v === LEARNED_FORMAT) {
          learnedCache.trusted = (Array.isArray(stored.trusted) ? stored.trusted : [])
            .filter((f) => typeof f === "string")
            .slice(-MAX_LEARNED);
          for (const [file, count] of Object.entries(stored.seen ?? {}).slice(-MAX_LEARNING)) {
            if (Number.isFinite(count) && count > 0) learnedCache.seen[file] = count;
          }
        }
      } catch {
        // Unreadable storage: start with nothing learned.
      }
    }
    return learnedCache;
  }

  function learnedFiles() {
    return learnedData().trusted;
  }

  // WhatsApp's incoming-message sound as it was last seen (kept across reloads), so the
  // extension can play WhatsApp's own ding even if WhatsApp renamed or moved the file.
  let soundUrl = null;
  function knownSoundUrl() {
    if (soundUrl === null) {
      soundUrl = KNOWN_INCOMING_SOUND_URL;
      try {
        const stored = window.localStorage?.getItem(SOUND_URL_KEY);
        if (stored && isWhatsAppSound(stored)) soundUrl = stored;
      } catch {
        // Keep the built-in one.
      }
    }
    return soundUrl;
  }
  function rememberSoundUrl(url) {
    if (!isWhatsAppSound(url) || url === soundUrl) return;
    soundUrl = url;
    try {
      window.localStorage?.setItem(SOUND_URL_KEY, url);
    } catch {
      // Remembered for this page only.
    }
  }

  /**
   * A sound that played right after a notification is probably the incoming-message sound. It is
   * trusted (and becomes WhatsApp's ding) only once it has done so LEARN_CONFIRMATIONS times.
   */
  function learn(url) {
    if (!isWhatsAppSound(url)) return;
    const file = soundFileName(url);
    if (!file) return;
    const data = learnedData();
    if (isKnownIncomingSound(url, data.trusted)) {
      rememberSoundUrl(url);
      return;
    }
    data.seen[file] = (data.seen[file] ?? 0) + 1;
    const files = Object.keys(data.seen);
    if (files.length > MAX_LEARNING) delete data.seen[files[0]];
    if (data.seen[file] >= LEARN_CONFIRMATIONS) {
      delete data.seen[file];
      data.trusted.push(file);
      if (data.trusted.length > MAX_LEARNED) data.trusted.shift();
      rememberSoundUrl(url);
    }
    try {
      window.localStorage?.setItem(
        LEARNED_KEY,
        JSON.stringify({ v: LEARNED_FORMAT, trusted: data.trusted, seen: data.seen })
      );
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
    setPending(answer.decision, {
      selfPlay: options?.silent !== true,
      chat: title == null ? "" : String(title),
    });
    return answer;
  }

  const ManagedNotification = function Notification(title, options) {
    if (!new.target) {
      throw new TypeError(
        "Failed to construct 'Notification': Please use the 'new' operator, this DOM object constructor cannot be called as a function."
      );
    }
    if (insideNotification) return new OriginalNotification(title, options);
    insideNotification = true;
    try {
      let answer = null;
      try {
        answer = consult(title, options);
      } catch {
        answer = null; // fail open
      }
      if (!answer) return new targetNotification(title, options);

      const permission = targetNotification.permission ?? OriginalNotification.permission;
      if (answer.showPopup && permission === "granted") {
        return new targetNotification(title, { ...(options || {}), silent: true });
      }
      return makeStub(title, options);
    } finally {
      insideNotification = false;
    }
  };

  if (OriginalNotification) {
    ManagedNotification.prototype = OriginalNotification.prototype;
    // WhatsApp may read the permission very often: ask the bridge at most once a second.
    let permissionAnswer = null;
    const spoofing = () => {
      if (!permissionAnswer || now() - permissionAnswer.at >= PERMISSION_CACHE_MS) {
        permissionAnswer = { at: now(), spoof: ask({ kind: "permission" })?.spoof === true };
      }
      return permissionAnswer.spoof;
    };
    Object.defineProperty(ManagedNotification, "permission", {
      get: () => (spoofing() ? "granted" : OriginalNotification.permission),
      enumerable: true,
      configurable: true,
    });
    ManagedNotification.requestPermission = function requestPermission(callback) {
      if (spoofing()) {
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
    // We just played a sound ourselves for this message: WhatsApp's own would be a second one.
    if (now() < quietUntil && isKnownIncomingSound(url, learnedFiles())) {
      if (recent) recent.claimed = true;
      clearPending();
      debug("WhatsApp's sound right after ours: kept quiet");
      return { action: "silent" };
    }
    const paired = freshPending();
    clearPending();
    if (paired) paired.claimed = true;
    if (paired?.selfPlayed) return { action: "silent" }; // we already played this one
    if (paired) {
      learn(url);
      recordDelay(now() - paired.at);
      silentRun = 0;
      signal({ type: "paired", url, ...meta });
      return forChat(paired.decision, paired.chat);
    }
    // Slower than the pairing window, but no sound has claimed the last notification yet: WhatsApp's
    // incoming sound (known or learned, never another WhatsApp sound such as "message sent") is
    // that notification's. Silenced if we already played the chat's sound for it.
    const late = isKnownIncomingSound(url, learnedFiles()) ? lateNotification() : null;
    if (late) {
      late.claimed = true;
      rememberSoundUrl(url);
      recordDelay(now() - late.at);
      silentRun = 0;
      signal({ type: "paired", url, ...meta });
      debug("WhatsApp's sound came late; it still belongs to the last notification");
      return late.selfPlayed ? { action: "silent" } : forChat(late.decision, late.chat);
    }
    if (isKnownIncomingSound(url, learnedFiles())) {
      rememberSoundUrl(url);
      // WhatsApp's incoming sound shortly after a notification we stopped waiting for: it is that
      // notification's, just slower than expected. Measure it, so the next one is caught.
      const since = now() - lastNotificationAt;
      if (since > pairingWindow() && since <= LATE_LOOKBACK_MS) recordDelay(since);
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
          if (insidePlay) return originalPlay.apply(this, args);
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
          // Silent: nothing plays. Your sound: played in a fresh page player instead of WhatsApp's.
          // Your sound not handed over: WhatsApp's own plays below (never silence).
          if (decision?.action === "silent") return Promise.resolve();
          if (decision?.action === "play") {
            if (playOwn(decision)) return Promise.resolve();
            signal({ type: "play-failed" });
          }
          insidePlay = true;
          try {
            return targetPlay.apply(this, args);
          } finally {
            insidePlay = false;
          }
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
            if (paired) paired.claimed = true;
            if (paired?.selfPlayed) {
              clearPending();
              decision = { action: "silent" }; // we already played this one
            } else if (paired) {
              clearPending();
              webAudioProven = true;
              silentRun = 0;
              debug("Web Audio sound after a notification ->", paired.decision);
              signal({ type: "paired", url: "", via: "webaudio", detached: false });
              decision = forChat(paired.decision, paired.chat);
            }
          } catch {
            decision = null; // fail open
          }
          if (decision?.action === "silent") return undefined;
          if (decision?.action === "play" && playOwn(decision)) return undefined;
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

  /**
   * Play WhatsApp's own ding, exactly as WhatsApp does (a new Audio element), through the
   * ORIGINAL play() so our own wrapper does not step in.
   */
  function onPlayNative() {
    try {
      const AudioCtor = window.Audio;
      if (typeof AudioCtor !== "function" || typeof originalPlay !== "function") return;
      const audio = new AudioCtor(knownSoundUrl());
      const result = originalPlay.call(audio);
      if (result && typeof result.catch === "function") result.catch(() => {});
      debug("played WhatsApp's own sound on request");
    } catch {
      // Nothing to play with.
    }
  }
  document.addEventListener(EVENT_PLAY_NATIVE, onPlayNative);

  // ---------------------------------------------------------------- your sounds, in the page

  // The bridge hands over the sounds in use; each becomes a blob URL that WhatsApp's page can play
  // (checked on real WhatsApp: its policy allows it). soundId -> blob URL.
  const library = new Map();

  function onSounds(event) {
    let sounds;
    try {
      sounds = JSON.parse(event.detail)?.sounds;
    } catch {
      return;
    }
    if (!Array.isArray(sounds)) return;
    for (const sound of sounds) {
      if (!sound || typeof sound.id !== "string") continue;
      const parsed = parseDataUrl(sound.dataUrl);
      if (!parsed || !/^audio\//.test(parsed.mime)) continue;
      try {
        const url = window.URL.createObjectURL(
          new window.Blob([parsed.bytes], { type: parsed.mime })
        );
        const old = library.get(sound.id);
        library.set(sound.id, url);
        if (old) window.URL.revokeObjectURL(old);
      } catch {
        // This sound stays unavailable: WhatsApp's own plays instead.
      }
    }
  }
  document.addEventListener(EVENT_SOUNDS, onSounds);

  /**
   * Play one of your sounds in a fresh player created by WhatsApp's page, through the original
   * play(): WhatsApp's own sound element is never changed (WhatsApp may reuse it). False when the
   * sound is not available, so the caller lets WhatsApp's own sound play.
   */
  function playOwn(decision) {
    const url = decision?.action === "play" ? library.get(decision.soundId) : null;
    if (!url || typeof window.Audio !== "function" || typeof originalPlay !== "function") {
      return false;
    }
    try {
      const audio = new window.Audio(url);
      if (Number.isFinite(decision.volume))
        audio.volume = Math.min(1, Math.max(0, decision.volume));
      // Its own play(): our wrapper passes your sound straight through (it is not WhatsApp's).
      const result = audio.play();
      if (result && typeof result.catch === "function") result.catch(() => {});
      debug("played your sound", decision.soundId);
      // Tell whoever listens (the debug log, tests) which sound played. Nothing acts on it.
      dispatch(EVENT_PLAY, {
        soundId: decision.soundId,
        volume: decision.volume,
        chat: decision.chat ?? "",
      });
      return true;
    } catch {
      return false;
    }
  }

  /** The bridge is playing a sound itself: keep WhatsApp's own incoming sound quiet a moment. */
  function onQuiet(event) {
    try {
      const ms = Number(JSON.parse(event.detail)?.ms);
      if (ms > 0) quietUntil = now() + Math.min(ms, MAX_QUIET_MS);
    } catch {
      // Ignore a malformed request.
    }
  }
  document.addEventListener(EVENT_QUIET, onQuiet);

  /**
   * Something replaced our wrappers: wrap what is there now and put ours back on top, so the
   * replacement keeps working underneath. Returns true if anything was put back.
   */
  function putBack() {
    let putBackAny = false;
    if (OriginalNotification && window.Notification !== ManagedNotification) {
      const current = window.Notification;
      try {
        window.Notification = ManagedNotification;
      } catch {
        // Locked by the page: reported as overwritten.
      }
      if (window.Notification === ManagedNotification) {
        if (typeof current === "function") targetNotification = current;
        putBackAny = true;
      }
    }
    if (wrappedPlay && mediaProto.play !== wrappedPlay) {
      const current = mediaProto.play;
      try {
        mediaProto.play = wrappedPlay;
      } catch {
        // Locked by the page: reported as overwritten.
      }
      if (mediaProto.play === wrappedPlay) {
        if (typeof current === "function") targetPlay = current;
        putBackAny = true;
      }
    }
    if (putBackAny) debug("something replaced our wrappers: put them back on top");
    return putBackAny;
  }

  /** The bridge asks "are you still in place?" because WhatsApp could replace our wrappers. */
  function onPing() {
    try {
      const healed = putBack();
      dispatch(EVENT_PONG, {
        notification: !OriginalNotification || window.Notification === ManagedNotification,
        play: !wrappedPlay || mediaProto.play === wrappedPlay,
        healed,
        sounds: library.size,
      });
    } catch {
      // Not answering is itself reported by the bridge.
    }
  }
  document.addEventListener(EVENT_PING, onPing);

  const api = {
    version: HOOK_VERSION,
    uninstall() {
      clearPending();
      document.removeEventListener(EVENT_PING, onPing);
      document.removeEventListener(EVENT_PLAY_NATIVE, onPlayNative);
      document.removeEventListener(EVENT_SOUNDS, onSounds);
      for (const url of library.values()) {
        try {
          window.URL.revokeObjectURL(url);
        } catch {
          // Already released.
        }
      }
      library.clear();
      document.removeEventListener(EVENT_QUIET, onQuiet);
      try {
        if (OriginalNotification) window.Notification = OriginalNotification;
      } catch {
        // Locked by the page: leave it.
      }
      try {
        if (wrappedPlay) mediaProto.play = originalPlay;
        if (wrappedShow) registrationProto.showNotification = originalShow;
        if (wrappedStart) sourceProto.start = originalStart;
      } catch {
        // Locked by the page: leave it.
      }
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
