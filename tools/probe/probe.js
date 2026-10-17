/* global window, document, console, ServiceWorkerRegistration, HTMLMediaElement, AudioBufferSourceNode */
// Phase 0 probe: records what WhatsApp Web passes to the browser notification and audio APIs.
// It is a throwaway research tool, not part of the shipped extension. Audio and service-worker
// calls pass straight through. Notifications are the exception: the probe tells the page that
// permission is granted and swallows the notification, so no desktop popup appears.
(() => {
  const MAX_ENTRIES = 50;
  const MAX_STRING = 300;
  const log = (window.__wansc_probe = []);

  function clip(value) {
    return typeof value === "string" && value.length > MAX_STRING
      ? value.slice(0, MAX_STRING) + "…"
      : value;
  }

  // Keep scalars as-is; summarize objects so we learn their shape (e.g. whether `data` carries a chat id).
  function describeOptions(options) {
    const out = {};
    if (!options || typeof options !== "object") return out;
    for (const key of Object.keys(options)) {
      const value = options[key];
      if (key === "body" && typeof value === "string") {
        // Never log message text. Keep only the shape needed to learn the group format:
        // the "Sender: " prefix (a name, not message content) and the length.
        const index = value.indexOf(": ");
        out.body = {
          length: value.length,
          senderPrefix: index > 0 && index <= 64 ? value.slice(0, index) : null,
        };
      } else if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        out[key] = clip(value);
      } else {
        try {
          out[key] = { __type: typeof value, json: clip(JSON.stringify(value)) };
        } catch {
          out[key] = { __type: typeof value, json: "(unserializable)" };
        }
      }
    }
    return out;
  }

  // WhatsApp only raises notifications when the tab is hidden/unfocused and permission is granted,
  // so every entry records that state to explain why a notification did or did not appear.
  function pageState() {
    return {
      visible: document.visibilityState,
      focused: document.hasFocus(),
      // The browser's REAL permission (what the page is told is always "granted" by this probe).
      permission: OriginalNotification ? OriginalNotification.permission : "unsupported",
    };
  }

  function record(kind, details) {
    const entry = { t: new Date().toISOString(), kind, ...details, page: pageState() };
    log.push(entry);
    if (log.length > MAX_ENTRIES) log.shift();
    // One flat JSON string: the DevTools console collapses nested objects into "{…}".
    console.log("[WANSC-PROBE] " + JSON.stringify(entry));
  }

  // 1. new Notification(title, options)
  //    Reports permission as "granted" so WhatsApp still raises the call even though the browser's
  //    real permission stays blocked, and returns an inert stub so NO desktop popup is ever shown.
  const OriginalNotification = window.Notification;

  function makeStub(title, options) {
    const o = options || {};
    return {
      title,
      body: o.body ?? "",
      tag: o.tag ?? "",
      icon: o.icon ?? "",
      data: o.data ?? null,
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
  }

  if (OriginalNotification) {
    function ProbeNotification(title, options) {
      record("notification", { title: clip(title), options: describeOptions(options) });
      return makeStub(title, options);
    }
    ProbeNotification.prototype = OriginalNotification.prototype;
    ProbeNotification.requestPermission = () => Promise.resolve("granted");
    Object.defineProperty(ProbeNotification, "permission", { get: () => "granted" });
    window.Notification = ProbeNotification;
  }

  // 2. registration.showNotification(title, options) -- if WhatsApp uses this, the page hook never sees it.
  if (typeof ServiceWorkerRegistration !== "undefined") {
    const original = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      record("showNotification", { title: clip(title), options: describeOptions(options) });
      return original.call(this, title, options);
    };
  }

  // 3 + 4. Does WhatsApp play its own sound through <audio>/Audio() or through Web Audio?
  if (typeof HTMLMediaElement !== "undefined") {
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      record("media.play", {
        src: clip(this.currentSrc || this.src || "(none)"),
        // A detached element means the page created it with `new Audio()` rather than an <audio> tag.
        attached: this.isConnected,
        muted: this.muted,
        volume: this.volume,
      });
      return originalPlay.apply(this, arguments);
    };
  }
  if (typeof AudioBufferSourceNode !== "undefined") {
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function () {
      record("webaudio.start", { duration: this.buffer ? this.buffer.duration : null });
      return originalStart.apply(this, arguments);
    };
  }

  // Not stored in the log: just confirms the probe loaded before WhatsApp's own scripts.
  console.log("[WANSC-PROBE] ready " + JSON.stringify(pageState()));
})();
