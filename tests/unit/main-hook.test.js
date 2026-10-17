import { describe, it, expect, vi, beforeEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { installMainHook } from "../../src/content/main-hook.mjs";
import { EVENT_ANSWER, EVENT_ASK, EVENT_PLAY } from "../../src/core/protocol.mjs";

const INCOMING = "https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3";

class FakeNotification {
  static instances = [];
  static permission = "denied";
  static requestPermission = vi.fn(() => Promise.resolve("denied"));
  get title() {
    throw new TypeError("Illegal invocation");
  }
  constructor(title, options) {
    this.ctorArgs = [title, options];
    FakeNotification.instances.push(this);
  }
}

class FakeMedia {
  static nativePlays = [];
  constructor(src) {
    this.src = src;
    this.currentSrc = src;
  }
  play() {
    FakeMedia.nativePlays.push(this.src);
    return Promise.resolve("native");
  }
}

let doc;
let win;
let clock;
let asked;
let playEvents;
let hook;

/** Stand-in for the isolated-world bridge: answers asks synchronously via `handler`. */
function connectBridge(handler) {
  doc.addEventListener(EVENT_ASK, (event) => {
    const question = JSON.parse(event.detail);
    asked.push(question);
    const answer = handler(question);
    if (answer)
      doc.dispatchEvent(new CustomEvent(EVENT_ANSWER, { detail: JSON.stringify(answer) }));
  });
}

const managed = (decision, extra = {}) => ({ mode: "managed", decision, ...extra });

beforeEach(() => {
  FakeNotification.instances = [];
  FakeNotification.permission = "denied";
  FakeNotification.requestPermission.mockClear();
  FakeMedia.nativePlays = [];
  doc = freshDocument();
  win = { Notification: FakeNotification, HTMLMediaElement: FakeMedia, CustomEvent };
  clock = { t: 1_000 };
  asked = [];
  playEvents = [];
  doc.addEventListener(EVENT_PLAY, (event) => playEvents.push(JSON.parse(event.detail)));
  hook = installMainHook({ window: win, document: doc, now: () => clock.t });
});

describe("permission spoofing", () => {
  it("reports granted when the bridge asks to spoof, while the real permission is denied", () => {
    connectBridge(() => ({ spoof: true }));
    expect(win.Notification.permission).toBe("granted");
    expect(FakeNotification.permission).toBe("denied");
  });

  it("reports the real permission when the bridge declines or is absent", () => {
    expect(win.Notification.permission).toBe("denied");
    connectBridge(() => ({ spoof: false }));
    expect(win.Notification.permission).toBe("denied");
  });

  it("answers requestPermission with granted, without prompting, when spoofing", async () => {
    connectBridge(() => ({ spoof: true }));
    const callback = vi.fn();
    await expect(win.Notification.requestPermission(callback)).resolves.toBe("granted");
    expect(callback).toHaveBeenCalledWith("granted");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("delegates requestPermission to the browser when not spoofing", async () => {
    connectBridge(() => ({ spoof: false }));
    await expect(win.Notification.requestPermission()).resolves.toBe("denied");
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe("notifications", () => {
  it("swallows a managed notification: no real Notification, an inert stub for the page", () => {
    connectBridge(() => managed({ action: "native" }));
    const stub = new win.Notification("Radwa", { tag: "601@lid", body: "hi" });

    expect(FakeNotification.instances).toHaveLength(0);
    expect(asked).toEqual([{ kind: "notification", title: "Radwa", tag: "601@lid", body: "hi" }]);
    expect(stub instanceof FakeNotification).toBe(true);
    expect(stub.title).toBe("Radwa");
    expect(stub.tag).toBe("601@lid");
    expect(() => {
      stub.onclick = () => {};
      stub.addEventListener("click", () => {});
      stub.close();
    }).not.toThrow();
    expect(stub.dispatchEvent({})).toBe(true);
  });

  it("passes through to the real Notification when nobody answers", () => {
    new win.Notification("Radwa", { tag: "601@lid" });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0].ctorArgs).toEqual(["Radwa", { tag: "601@lid" }]);
  });

  it("passes through when the bridge says pass (extension disabled)", () => {
    connectBridge(() => ({ mode: "pass" }));
    new win.Notification("Radwa");
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("shows a real, silent notification when popups are enabled and permitted", () => {
    FakeNotification.permission = "granted";
    connectBridge(() => managed({ action: "native" }, { showPopup: true }));
    new win.Notification("Radwa", { body: "hi" });
    expect(FakeNotification.instances[0].ctorArgs[1]).toEqual({ body: "hi", silent: true });
  });

  it("falls back to the stub when popups are enabled but the browser blocks them", () => {
    connectBridge(() => managed({ action: "native" }, { showPopup: true }));
    new win.Notification("Radwa");
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("refuses to be called without new, like the native constructor", () => {
    expect(() => win.Notification("x")).toThrow(TypeError);
  });

  it("copes with a missing title and options", () => {
    connectBridge(() => managed({ action: "native" }));
    expect(() => new win.Notification()).not.toThrow();
    expect(asked[0]).toEqual({ kind: "notification", title: "", tag: "", body: "" });
  });
});

describe("sound replacement", () => {
  const play = (src = INCOMING) => new win.HTMLMediaElement(src).play();

  it("replaces WhatsApp's sound with the chosen one and blocks the original", async () => {
    connectBridge(() => managed({ action: "play", soundId: "s1", volume: 0.5 }));
    new win.Notification("Radwa", { tag: "601@lid" });

    await play();

    expect(FakeMedia.nativePlays).toEqual([]);
    expect(playEvents).toEqual([{ soundId: "s1", volume: 0.5 }]);
  });

  it("blocks the sound entirely for a silent decision", async () => {
    connectBridge(() => managed({ action: "silent" }));
    new win.Notification("Radwa");
    await play();
    expect(FakeMedia.nativePlays).toEqual([]);
    expect(playEvents).toEqual([]);
  });

  it("lets WhatsApp's own sound through for a native decision", async () => {
    connectBridge(() => managed({ action: "native" }));
    new win.Notification("Radwa");
    await play();
    expect(FakeMedia.nativePlays).toEqual([INCOMING]);
    expect(playEvents).toEqual([]);
  });

  it("uses a notification for exactly one sound", async () => {
    connectBridge((q) =>
      q.kind === "notification" ? managed({ action: "play", soundId: "s1", volume: 1 }) : null
    );
    new win.Notification("Radwa");
    await play("https://static.whatsapp.net/rsrc.php/x/other.mp3");
    await play("https://static.whatsapp.net/rsrc.php/x/other.mp3");
    expect(playEvents).toHaveLength(1);
    expect(FakeMedia.nativePlays).toHaveLength(1);
  });

  it("ignores a notification once the pairing window has passed", async () => {
    connectBridge((q) =>
      q.kind === "notification" ? managed({ action: "play", soundId: "s1", volume: 1 }) : null
    );
    new win.Notification("Radwa");
    clock.t += 501;
    await play("https://static.whatsapp.net/rsrc.php/x/other.mp3");
    expect(playEvents).toEqual([]);
    expect(FakeMedia.nativePlays).toHaveLength(1);
  });

  it("applies the default sound to the incoming-message sound when no notification came first", async () => {
    connectBridge((q) =>
      q.kind === "default-sound" ? { decision: { action: "play", soundId: "d", volume: 1 } } : null
    );
    await play();
    expect(asked).toEqual([{ kind: "default-sound" }]);
    expect(playEvents).toEqual([{ soundId: "d", volume: 1 }]);
    expect(FakeMedia.nativePlays).toEqual([]);
  });

  it("leaves an unrecognised sound alone when no notification came first", async () => {
    connectBridge(() => ({ decision: { action: "silent" } }));
    await play("https://static.whatsapp.net/rsrc.php/x/ringtone.mp3");
    expect(asked).toEqual([]);
    expect(FakeMedia.nativePlays).toHaveLength(1);
  });

  it("never touches media that is not WhatsApp's own sound, and keeps the pairing for later", async () => {
    connectBridge((q) =>
      q.kind === "notification" ? managed({ action: "play", soundId: "s1", volume: 1 }) : null
    );
    new win.Notification("Radwa");
    await play("blob:https://web.whatsapp.com/voice-message");
    expect(FakeMedia.nativePlays).toHaveLength(1);
    expect(playEvents).toEqual([]);

    await play();
    expect(playEvents).toEqual([{ soundId: "s1", volume: 1 }]);
  });

  it("returns a promise like the native play()", () => {
    connectBridge(() => managed({ action: "silent" }));
    new win.Notification("Radwa");
    expect(play()).toBeInstanceOf(Promise);
  });
});

describe("being injected twice", () => {
  it("does not wrap Notification or play() a second time", async () => {
    connectBridge(() => managed({ action: "play", soundId: "s1", volume: 1 }));
    const wrapped = win.Notification;
    const again = installMainHook({ window: win, document: doc, now: () => clock.t });

    expect(again).toBe(hook);
    expect(win.Notification).toBe(wrapped);

    new win.Notification("Radwa");
    await new win.HTMLMediaElement(INCOMING).play();
    expect(asked.filter((q) => q.kind === "notification")).toHaveLength(1); // asked once, not twice
    expect(playEvents).toHaveLength(1);
  });

  it("keeps its marker out of ordinary enumeration", () => {
    expect(Object.keys(win)).not.toContain("wansc.main-hook");
    expect(JSON.stringify(Object.keys(win))).not.toMatch(/wansc/);
  });

  it("can be installed again after uninstall", () => {
    hook.uninstall();
    const fresh = installMainHook({ window: win, document: doc, now: () => clock.t });
    expect(fresh).not.toBe(hook);
    expect(win.Notification).not.toBe(FakeNotification);
  });
});

describe("uninstall", () => {
  it("restores the original Notification and play()", async () => {
    hook.uninstall();
    expect(win.Notification).toBe(FakeNotification);
    await new FakeMedia(INCOMING).play();
    expect(FakeMedia.nativePlays).toEqual([INCOMING]);
  });
});
