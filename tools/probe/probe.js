/* global window, console, ServiceWorkerRegistration, HTMLMediaElement, AudioBufferSourceNode */
// Phase 0 probe: records what WhatsApp Web passes to the browser notification and audio APIs.
// It is a throwaway research tool, not part of the shipped extension. It never changes behavior:
// every call is passed straight through to the original implementation.
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
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
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

  function record(kind, details) {
    const entry = { t: new Date().toISOString(), kind, ...details };
    log.push(entry);
    if (log.length > MAX_ENTRIES) log.shift();
    console.log("[WANSC-PROBE]", entry);
  }

  // 1. new Notification(title, options)
  const OriginalNotification = window.Notification;
  if (OriginalNotification) {
    function ProbeNotification(title, options) {
      record("notification", { title: clip(title), options: describeOptions(options) });
      return new OriginalNotification(title, options);
    }
    ProbeNotification.prototype = OriginalNotification.prototype;
    ProbeNotification.requestPermission =
      OriginalNotification.requestPermission.bind(OriginalNotification);
    Object.defineProperty(ProbeNotification, "permission", {
      get: () => OriginalNotification.permission,
    });
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
      record("media.play", { src: clip(this.currentSrc || this.src || "(none)") });
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
})();
