import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { installMainHook } from "../../src/content/main-hook.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PING,
  EVENT_PLAY,
  EVENT_PONG,
  EVENT_SIGNAL,
} from "../../src/core/protocol.mjs";

// What if WhatsApp changes? These scenarios model the ways it plausibly could, and pin down that
// the hook either keeps working or leaves WhatsApp alone, never breaks it.

const ORIGINAL = "https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3";
const RENAMED = "https://static.whatsapp.net/rsrc.php/zZ/r/NewHash123.mp3";
const MOVED = "https://media-cdn.example-edge.net/sounds/incoming.ogg";

class FakeNotification {
  static instances = [];
  static permission = "denied";
  static requestPermission = vi.fn(() => Promise.resolve("denied"));
  constructor(title, options) {
    this.ctorArgs = [title, options];
    FakeNotification.instances.push(this);
  }
}

class FakeMedia {
  static nativePlays = [];
  constructor(src, { connected = false } = {}) {
    this.src = src;
    this.currentSrc = src;
    this.isConnected = connected;
  }
  play() {
    FakeMedia.nativePlays.push(this.src);
    return Promise.resolve("native");
  }
}

class FakeSource {
  static starts = 0;
  start() {
    FakeSource.starts += 1;
  }
}

class FakeRegistration {
  static shown = [];
  showNotification(title, options) {
    FakeRegistration.shown.push([title, options]);
    return Promise.resolve();
  }
}

let doc;
let win;
let clock;
let playEvents;
let signals;
let store;
let hook;

const managed = (decision, extra = {}) => ({ mode: "managed", decision, ...extra });
const PLAY = { action: "play", soundId: "s1", volume: 1 };

function connectBridge(handler) {
  doc.addEventListener(EVENT_ASK, (event) => {
    const answer = handler(JSON.parse(event.detail));
    if (answer) {
      doc.dispatchEvent(new CustomEvent(EVENT_ANSWER, { detail: JSON.stringify(answer) }));
    }
  });
}

const bridgeSaysPlay = () =>
  connectBridge((q) => {
    if (q.kind === "notification") return managed(PLAY);
    if (q.kind === "default-sound") return { decision: PLAY };
    return null;
  });

const play = (src, options) => new win.HTMLMediaElement(src, options).play();
// Real WhatsApp always passes silent: true and plays its own sound (measured, Oct 2026).
const whatsappNotifies = (title, options) =>
  new win.Notification(title, { silent: true, ...options });

function install() {
  hook = installMainHook({ window: win, document: doc, now: () => clock.t });
}

beforeEach(() => {
  FakeNotification.instances = [];
  FakeMedia.nativePlays = [];
  FakeSource.starts = 0;
  FakeRegistration.shown = [];
  store = {};
  doc = freshDocument();
  win = {
    Notification: FakeNotification,
    HTMLMediaElement: FakeMedia,
    AudioBufferSourceNode: FakeSource,
    ServiceWorkerRegistration: FakeRegistration,
    CustomEvent,
    localStorage: {
      getItem: (key) => store[key] ?? null,
      setItem: (key, value) => (store[key] = String(value)),
    },
  };
  clock = { t: 1_000 };
  playEvents = [];
  signals = [];
  doc.addEventListener(EVENT_PLAY, (event) => playEvents.push(JSON.parse(event.detail)));
  doc.addEventListener(EVENT_SIGNAL, (event) => signals.push(JSON.parse(event.detail)));
  install();
});

afterEach(() => {
  vi.useRealTimers();
  hook.uninstall(); // the fake classes are shared, so wrappers must not pile up across tests
});

describe("when WhatsApp renames or moves its sound", () => {
  it("still replaces a renamed file served from WhatsApp", async () => {
    bridgeSaysPlay();
    whatsappNotifies("Radwa", { tag: "601@lid" });
    await play(RENAMED);
    expect(playEvents).toHaveLength(1);
    expect(FakeMedia.nativePlays).toEqual([]);
  });

  it("still replaces a different file type", async () => {
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    await play("https://static.whatsapp.net/rsrc.php/x/new-sound.ogg");
    expect(playEvents).toHaveLength(1);
  });

  it("recognises the sound by behaviour when the host changes too: detached element right after a notification", async () => {
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    await play(MOVED);
    expect(playEvents).toHaveLength(1);
    expect(FakeMedia.nativePlays).toEqual([]);
    expect(signals.find((s) => s.type === "paired")).toMatchObject({ detached: true });
  });

  it("does not take over a voice message (a blob URL), even right after a notification", async () => {
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    await play("blob:https://web.whatsapp.com/voice-note");
    expect(FakeMedia.nativePlays).toHaveLength(1);
    expect(playEvents).toEqual([]);
  });

  it("does not take over media that lives in the page (a video), even right after a notification", async () => {
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    await play("https://video.example.com/clip.mp4", { connected: true });
    expect(FakeMedia.nativePlays).toHaveLength(1);
    expect(playEvents).toEqual([]);
  });

  it("does not take over a detached element that plays long after the notification", async () => {
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    clock.t += 501;
    await play(MOVED);
    expect(FakeMedia.nativePlays).toHaveLength(1);
    expect(playEvents).toEqual([]);
  });
});

describe("learning the incoming-message sound", () => {
  it("remembers a sound that followed a notification and then replaces it when the tab is focused", async () => {
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    await play(RENAMED); // learned here

    expect(JSON.parse(store.wanscLearnedSounds)).toEqual(["NewHash123.mp3"]);

    clock.t += 5_000; // no notification this time, as when the tab is focused
    await play(RENAMED);
    expect(playEvents).toHaveLength(2);
    expect(FakeMedia.nativePlays).toEqual([]);
    expect(signals.some((s) => s.type === "unpaired")).toBe(true);
  });

  it("starts with what it learned before (a fresh page load)", async () => {
    store.wanscLearnedSounds = JSON.stringify(["NewHash123.mp3"]);
    bridgeSaysPlay();
    await play(RENAMED);
    expect(playEvents).toHaveLength(1);
  });

  it("does not touch an unknown sound it has never seen follow a notification", async () => {
    bridgeSaysPlay();
    await play(RENAMED);
    expect(playEvents).toEqual([]);
    expect(FakeMedia.nativePlays).toEqual([RENAMED]);
  });

  it("survives corrupt or blocked storage", async () => {
    store.wanscLearnedSounds = "not json";
    bridgeSaysPlay();
    whatsappNotifies("a");
    await play(RENAMED);
    expect(JSON.parse(store.wanscLearnedSounds)).toEqual(["NewHash123.mp3"]);

    win.localStorage.setItem = () => {
      throw new Error("quota");
    };
    whatsappNotifies("b");
    await expect(
      play("https://static.whatsapp.net/rsrc.php/x/Another.mp3")
    ).resolves.toBeUndefined();
  });

  it("keeps only the most recent few", async () => {
    bridgeSaysPlay();
    for (let i = 1; i <= 7; i++) {
      whatsappNotifies(`chat${i}`);
      await play(`https://static.whatsapp.net/rsrc.php/x/file${i}.mp3`);
    }
    expect(JSON.parse(store.wanscLearnedSounds)).toEqual([
      "file3.mp3",
      "file4.mp3",
      "file5.mp3",
      "file6.mp3",
      "file7.mp3",
    ]);
  });

  it("never learns a sound from outside WhatsApp", async () => {
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    await play(MOVED);
    expect(store.wanscLearnedSounds).toBeUndefined();
  });

  it("still knows the originally measured file without having learned anything", async () => {
    bridgeSaysPlay();
    await play(ORIGINAL);
    expect(playEvents).toHaveLength(1);
  });
});

describe("telling the bridge what happened", () => {
  it("signals a sound handled after a notification", async () => {
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    await play(RENAMED);
    const paired = signals.find((s) => s.type === "paired");
    expect(paired).toMatchObject({ via: "audio", detached: true });
    expect(paired.url).toBe(RENAMED); // the bridge reduces this to host and type before storing
  });

  it("signals a notification that no sound followed", () => {
    vi.useFakeTimers();
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    vi.advanceTimersByTime(1_499);
    expect(signals.filter((s) => s.type === "silent")).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(signals.filter((s) => s.type === "silent")).toHaveLength(1);
  });

  it("does not signal silence when the sound did arrive", async () => {
    vi.useFakeTimers();
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    await play(ORIGINAL);
    vi.advanceTimersByTime(5_000);
    expect(signals.filter((s) => s.type === "silent")).toHaveLength(0);
  });

  it("does not signal silence for a notification it does not manage", () => {
    vi.useFakeTimers();
    connectBridge(() => ({ mode: "pass" }));
    whatsappNotifies("Radwa");
    vi.advanceTimersByTime(5_000);
    expect(signals).toEqual([]);
  });
});

describe("Web Audio fallback", () => {
  const startSource = () => new FakeSource().start();

  function silenceTwice() {
    vi.useFakeTimers();
    for (let i = 0; i < 2; i++) {
      whatsappNotifies("Radwa");
      clock.t += 2_000;
      vi.advanceTimersByTime(2_000);
    }
  }

  it("leaves Web Audio alone while the normal route works", () => {
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    startSource();
    expect(FakeSource.starts).toBe(1);
    expect(playEvents).toEqual([]);
  });

  it("takes over once notifications repeatedly arrive with no <audio> sound", () => {
    bridgeSaysPlay();
    silenceTwice();

    whatsappNotifies("Radwa");
    startSource();

    expect(FakeSource.starts).toBe(0);
    expect(playEvents).toHaveLength(1);
    expect(signals.find((s) => s.via === "webaudio")).toMatchObject({ type: "paired" });
  });

  it("keeps working on the next message once it has been seen to work", () => {
    bridgeSaysPlay();
    silenceTwice();
    whatsappNotifies("a");
    startSource();
    clock.t += 5_000;
    whatsappNotifies("b");
    startSource();
    expect(playEvents).toHaveLength(2);
    expect(FakeSource.starts).toBe(0);
  });

  it("lets a native decision through", () => {
    connectBridge((q) => (q.kind === "notification" ? managed({ action: "native" }) : null));
    silenceTwice();
    whatsappNotifies("Radwa");
    startSource();
    expect(FakeSource.starts).toBe(1);
  });
});

describe("notifications raised through the service worker", () => {
  it("swallows a managed one and pairs its sound", async () => {
    bridgeSaysPlay();
    const registration = new win.ServiceWorkerRegistration();
    await expect(
      registration.showNotification("Radwa", { tag: "601@lid", body: "hi" })
    ).resolves.toBeUndefined();
    expect(FakeRegistration.shown).toEqual([]);

    await play(ORIGINAL);
    expect(playEvents).toHaveLength(1);
  });

  it("shows it, silently, when popups are wanted", async () => {
    connectBridge(() => managed({ action: "native" }, { showPopup: true }));
    await new win.ServiceWorkerRegistration().showNotification("Radwa", { body: "hi" });
    expect(FakeRegistration.shown).toEqual([["Radwa", { body: "hi", silent: true }]]);
  });

  it("passes it through untouched when nobody answers", async () => {
    await new win.ServiceWorkerRegistration().showNotification("Radwa", { body: "hi" });
    expect(FakeRegistration.shown).toEqual([["Radwa", { body: "hi" }]]);
  });
});

describe("checking itself", () => {
  const ping = () => {
    let pong = null;
    const onPong = (event) => (pong = JSON.parse(event.detail));
    doc.addEventListener(EVENT_PONG, onPong);
    doc.dispatchEvent(new CustomEvent(EVENT_PING));
    doc.removeEventListener(EVENT_PONG, onPong);
    return pong;
  };

  it("answers a ping when everything is in place", () => {
    expect(ping()).toEqual({ notification: true, play: true });
  });

  it("reports when WhatsApp replaced Notification", () => {
    win.Notification = class Other {};
    expect(ping()).toMatchObject({ notification: false, play: true });
  });

  it("reports when WhatsApp replaced play()", () => {
    win.HTMLMediaElement.prototype.play = () => Promise.resolve();
    expect(ping()).toMatchObject({ notification: true, play: false });
  });

  it("stops answering once uninstalled, which the bridge reads as 'missing'", () => {
    hook.uninstall();
    expect(ping()).toBeNull();
  });
});

describe("failing open", () => {
  it("passes the real Notification through if the bridge cannot be reached at all", () => {
    win.CustomEvent = function Broken() {
      throw new Error("events blocked");
    };
    expect(() => whatsappNotifies("Radwa", { tag: "t" })).not.toThrow();
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("plays WhatsApp's own sound if the bridge cannot be reached at all", async () => {
    win.CustomEvent = function Broken() {
      throw new Error("events blocked");
    };
    await play(ORIGINAL);
    expect(FakeMedia.nativePlays).toEqual([ORIGINAL]);
  });

  it("still plays WhatsApp's sound if reading the element's URL throws", async () => {
    const odd = new win.HTMLMediaElement(ORIGINAL);
    Object.defineProperty(odd, "currentSrc", {
      get() {
        throw new Error("odd element");
      },
    });
    await odd.play();
    expect(FakeMedia.nativePlays).toEqual([ORIGINAL]);
  });
});

describe("browsers without the optional APIs", () => {
  it("installs fine with no Web Audio, service worker or localStorage", async () => {
    hook.uninstall();
    delete win.AudioBufferSourceNode;
    delete win.ServiceWorkerRegistration;
    delete win.localStorage;
    install();
    bridgeSaysPlay();
    whatsappNotifies("Radwa");
    await play(RENAMED);
    expect(playEvents).toHaveLength(1);
  });
});
