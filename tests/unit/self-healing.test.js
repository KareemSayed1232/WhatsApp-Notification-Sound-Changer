import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withPageSounds } from "../helpers/page-sounds.js";
import { freshDocument } from "../helpers/load-script.js";
import { startBridge } from "../../src/content/bridge.mjs";
import { installMainHook } from "../../src/content/main-hook.mjs";
import { buildDiagnostics, healthStatus } from "../../src/core/health.mjs";

// WhatsApp (or another extension) may replace `Notification` or `play()` after the hook wrapped
// them. Instead of asking the user to reload, the hook wraps whatever is there now and puts itself
// back on top, at the next 30-second check. Whatever replaced it keeps working underneath.

const INCOMING = "https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3";

describe("the hook putting itself back", () => {
  let doc;
  let win;
  let data;
  let bridge;
  let hook;
  let played;

  async function boot({ showPopups = false } = {}) {
    data = {
      settings: { enabled: true, volume: 0.8, defaultSoundId: "s1", showPopups },
      sounds: { s1: { id: "s1", name: "Ping", mime: "audio/mpeg", size: 3 } },
      rules: [],
    };
    doc = freshDocument();
    played = [];
    class FakeNotification {
      static permission = "denied";
    }
    class FakeMedia {
      play() {
        played.push("native");
        return Promise.resolve();
      }
    }
    win = { Notification: FakeNotification, HTMLMediaElement: FakeMedia, CustomEvent };
    hook = installMainHook({ window: win, document: doc });
    withPageSounds(win, doc);
    bridge = startBridge({
      chrome: {
        storage: {
          local: {
            get: vi.fn(async (keys) =>
              Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))
            ),
            set: vi.fn(async (items) => Object.assign(data, items)),
          },
          onChanged: { addListener: () => {}, removeListener: () => {} },
        },
        runtime: { id: "ext", sendMessage: vi.fn(async () => ({ ok: true })) },
      },
      document: doc,
      engine: { play: vi.fn(async () => true), invalidate: vi.fn(), canPlay: () => true },
      CustomEventCtor: CustomEvent,
    });
    await bridge.ready;
  }

  const nextCheck = () => vi.advanceTimersByTimeAsync(31_000);
  const whatsappNotifies = (title, options) =>
    new win.Notification(title, { silent: true, ...options });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    bridge?.stop();
    hook?.uninstall();
    hook = null;
    vi.useRealTimers();
  });

  it("re-wraps a replaced Notification, and the status stays OK", async () => {
    await boot();
    const made = [];
    win.Notification = class WhatsAppsOwn {
      constructor(title) {
        made.push(title);
      }
    };
    await nextCheck();
    expect(data.health.hook.state).toBe("ok");
    expect(data.health.hookHealed).toBe(1);

    whatsappNotifies("Radwa", { tag: "601@lid" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(data.health.notifications).toBe(1); // ours again: the notification was consulted
    expect(made).toEqual([]); // and the pop-up stays hidden
  });

  it("keeps the replacement working underneath when pop-ups are shown", async () => {
    await boot({ showPopups: true });
    const made = [];
    win.Notification = class WhatsAppsOwn {
      static permission = "granted";
      constructor(title) {
        made.push(title);
      }
    };
    await nextCheck();
    whatsappNotifies("Radwa", { tag: "601@lid" });
    expect(made).toEqual(["Radwa"]);
  });

  it("does not loop when the replacement itself calls the one it replaced", async () => {
    await boot({ showPopups: true }); // so the replacement is actually called
    const ours = win.Notification;
    let calls = 0;
    win.Notification = function Wrapper(title, options) {
      calls += 1;
      return new ours(title, options);
    };
    win.Notification.permission = "granted";
    await nextCheck();
    expect(() => whatsappNotifies("Radwa", { tag: "601@lid" })).not.toThrow();
    expect(calls).toBe(1);
  });

  it("re-wraps a replaced play(), so WhatsApp's sound is replaced again", async () => {
    await boot();
    const mediaProto = win.HTMLMediaElement.prototype;
    mediaProto.play = function theirPlay() {
      played.push("theirs");
      return Promise.resolve();
    };
    await nextCheck();
    expect(data.health.hook.state).toBe("ok");
    whatsappNotifies("Radwa", { tag: "601@lid" });
    const audio = new win.HTMLMediaElement();
    audio.src = INCOMING;
    await audio.play();
    expect(played).toEqual([]); // WhatsApp's sound muted, ours played instead
  });

  it("still says so when it cannot put itself back", async () => {
    await boot();
    Object.defineProperty(win, "Notification", {
      value: class Locked {},
      writable: false,
      configurable: false,
    });
    await nextCheck();
    expect(data.health.hook.state).toBe("overwritten");
  });
});

describe("the status record of healing", () => {
  it("shows in diagnostics and does not change the verdict", () => {
    const health = { hook: { state: "ok", checkedAt: 1 }, hookHealed: 2, lastPairedAt: 5 };
    expect(healthStatus(health).code).toBe("working");
    const report = buildDiagnostics({ version: "3", userAgent: "x", health, state: {}, now: 9 });
    expect(report.hook.timesPutBack).toBe(2);
  });
});
