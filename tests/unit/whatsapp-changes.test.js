import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withPageSounds } from "../helpers/page-sounds.js";
import { freshDocument } from "../helpers/load-script.js";
import { installMainHook } from "../../src/content/main-hook.mjs";
import { applySignal, emptyHealth, healthStatus } from "../../src/core/health.mjs";
import { EVENT_ANSWER, EVENT_ASK, EVENT_PLAY, EVENT_SIGNAL } from "../../src/core/protocol.mjs";
import { healthMessage } from "../../src/ui/health-ui.mjs";
import { STRINGS as S } from "../../src/ui/strings.mjs";

// Phase A of the "what if WhatsApp changes" plan: the changes that would otherwise silently stop
// per-chat sounds without the status line noticing.

const INCOMING = "https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3";
const PLAY = { action: "play", soundId: "s1", volume: 1 };
const managed = (decision) => ({ mode: "managed", decision });

// ------------------------------------------------------------------ a fake WhatsApp page

class FakeNotification {
  static permission = "denied";
  static requestPermission = vi.fn(async () => "denied");
}

class FakeMedia {
  static nativePlays = [];
  constructor(src) {
    this.src = src;
    this.currentSrc = src;
    this.isConnected = false;
  }
  play() {
    FakeMedia.nativePlays.push(this.src);
    return Promise.resolve();
  }
}

let doc;
let win;
let clock;
let hook;
let playEvents;
let signals;
let realQuery;

function connectBridge(handler) {
  doc.addEventListener(EVENT_ASK, (event) => {
    const answer = handler(JSON.parse(event.detail));
    if (answer) {
      doc.dispatchEvent(new CustomEvent(EVENT_ANSWER, { detail: JSON.stringify(answer) }));
    }
  });
}

function setupPage() {
  FakeMedia.nativePlays = [];
  doc = freshDocument();
  realQuery = vi.fn(async (descriptor) => ({ name: descriptor?.name, state: "denied" }));
  win = {
    Notification: FakeNotification,
    HTMLMediaElement: FakeMedia,
    CustomEvent,
    navigator: { permissions: { query: realQuery } },
  };
  clock = { t: 1_000 };
  playEvents = [];
  signals = [];
  doc.addEventListener(EVENT_PLAY, (event) => playEvents.push(JSON.parse(event.detail)));
  doc.addEventListener(EVENT_SIGNAL, (event) => signals.push(JSON.parse(event.detail)));
  hook = installMainHook({ window: win, document: doc, now: () => clock.t });
  withPageSounds(win, doc);
}

function teardownPage() {
  vi.useRealTimers();
  hook?.uninstall();
  hook = null;
}

// ------------------------------------------------------------------ A1

describe("A1: WhatsApp asks for permission through navigator.permissions", () => {
  beforeEach(setupPage);
  afterEach(teardownPage);

  it("answers 'granted' for notifications while we are hiding popups, without asking the browser", async () => {
    connectBridge((q) => (q.kind === "permission" ? { spoof: true } : null));
    const status = await win.navigator.permissions.query({ name: "notifications" });
    expect(status.state).toBe("granted");
    expect(status.name).toBe("notifications");
    expect(realQuery).not.toHaveBeenCalled();
  });

  it("gives back something that behaves like a PermissionStatus", async () => {
    connectBridge(() => ({ spoof: true }));
    const status = await win.navigator.permissions.query({ name: "notifications" });
    expect(status.onchange).toBeNull();
    expect(() => {
      status.onchange = () => {};
      status.addEventListener("change", () => {});
      status.removeEventListener("change", () => {});
    }).not.toThrow();
    expect(status.dispatchEvent({})).toBe(true);
  });

  it("leaves other permissions to the browser", async () => {
    connectBridge(() => ({ spoof: true }));
    const status = await win.navigator.permissions.query({ name: "microphone" });
    expect(status.state).toBe("denied");
    expect(realQuery).toHaveBeenCalledWith({ name: "microphone" });
  });

  it("asks the browser when we are not spoofing, or the bridge is not there", async () => {
    expect((await win.navigator.permissions.query({ name: "notifications" })).state).toBe("denied");
    connectBridge(() => ({ spoof: false }));
    expect((await win.navigator.permissions.query({ name: "notifications" })).state).toBe("denied");
    expect(realQuery).toHaveBeenCalledTimes(2);
  });

  it("passes odd arguments straight to the browser", async () => {
    connectBridge(() => ({ spoof: true }));
    await win.navigator.permissions.query(undefined);
    expect(realQuery).toHaveBeenCalledWith(undefined);
  });

  it("puts the browser's query back on uninstall", () => {
    hook.uninstall();
    expect(win.navigator.permissions.query).toBe(realQuery);
  });

  it("installs fine where navigator.permissions does not exist", () => {
    hook.uninstall();
    delete win.navigator;
    expect(() => {
      hook = installMainHook({ window: win, document: doc, now: () => clock.t });
      withPageSounds(win, doc);
    }).not.toThrow();
  });
});

// ------------------------------------------------------------------ A2

// ------------------------------------------------------------------ A3

describe("A3: WhatsApp plays sounds but stops saying which chat", () => {
  describe("the hook", () => {
    beforeEach(setupPage);
    afterEach(teardownPage);

    const answerDefault = () =>
      connectBridge((q) => (q.kind === "default-sound" ? { decision: PLAY } : null));

    it("marks a sound with no notification while the tab is in the background", async () => {
      Object.defineProperty(doc, "visibilityState", { value: "hidden", configurable: true });
      answerDefault();
      await new win.HTMLMediaElement(INCOMING).play();
      expect(signals.find((s) => s.type === "unpaired")).toMatchObject({ background: true });
    });

    it("does not when the tab is visible and focused (WhatsApp never notifies then)", async () => {
      Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
      doc.hasFocus = () => true;
      answerDefault();
      await new win.HTMLMediaElement(INCOMING).play();
      expect(signals.find((s) => s.type === "unpaired")).toMatchObject({ background: false });
    });

    it("counts a visible but unfocused window as background", async () => {
      Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
      doc.hasFocus = () => false;
      answerDefault();
      await new win.HTMLMediaElement(INCOMING).play();
      expect(signals.find((s) => s.type === "unpaired")).toMatchObject({ background: true });
    });
  });

  describe("the status", () => {
    const anonymous = { type: "unpaired", url: INCOMING, background: true };
    const fold = (list) => list.reduce((h, s) => applySignal(h, s, 5), emptyHealth());

    it("warns after several background sounds that came without a notification", () => {
      expect(healthStatus(fold([anonymous, anonymous])).code).toBe("working");
      expect(healthStatus(fold([anonymous, anonymous, anonymous]))).toMatchObject({
        code: "no-chat-info",
        level: "warn",
      });
    });

    it("does not warn about sounds while the tab was focused", () => {
      const focused = { ...anonymous, background: false };
      expect(healthStatus(fold([focused, focused, focused, focused])).code).toBe("working");
    });

    it("clears once WhatsApp names a chat again", () => {
      const named = [anonymous, anonymous, anonymous, { type: "notification", tag: "1@lid" }];
      expect(healthStatus(fold(named)).code).not.toBe("no-chat-info");
      const paired = [anonymous, anonymous, anonymous, { type: "paired", url: INCOMING }];
      expect(healthStatus(fold(paired)).code).toBe("working");
    });

    it("explains it in plain words", () => {
      const health = fold([anonymous, anonymous, anonymous]);
      expect(healthMessage(health, 10)).toEqual({ level: "warn", text: S.healthNoChatInfo });
      expect(S.healthNoChatInfo).toMatch(/which chat/);
    });

    it("survives a stored record from before this existed", () => {
      expect(healthStatus({ lastPairedAt: 3 }).code).toBe("working");
    });
  });
});

// ------------------------------------------------------------------ A4

describe("A4: WhatsApp stops playing its own sound", () => {
  beforeEach(() => {
    setupPage();
    vi.useFakeTimers();
  });
  afterEach(teardownPage);

  const bridgeSays = (decision) =>
    connectBridge((q) => (q.kind === "notification" ? managed(decision) : null));

  it("plays the chat's sound itself when a notification meant to make a sound gets none", () => {
    bridgeSays(PLAY);
    new win.Notification("Radwa", { tag: "601@lid" }); // not silent: the OS would have rung
    vi.advanceTimersByTime(149);
    expect(playEvents).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(playEvents).toEqual([expect.objectContaining({ soundId: "s1", volume: 1 })]);
    expect(signals.find((s) => s.type === "self-played")).toBeTruthy();
  });

  it("does not play twice when WhatsApp's own sound arrives late", async () => {
    bridgeSays(PLAY);
    new win.Notification("Radwa", { tag: "601@lid", silent: false });
    vi.advanceTimersByTime(200);
    clock.t += 200;
    await new win.HTMLMediaElement(INCOMING).play();
    expect(playEvents).toHaveLength(1);
    expect(FakeMedia.nativePlays).toEqual([]); // the late original is still suppressed
  });

  it("waits for WhatsApp's sound as today when WhatsApp marks the notification silent", () => {
    bridgeSays(PLAY);
    new win.Notification("Radwa", { tag: "601@lid", silent: true });
    vi.advanceTimersByTime(1_000);
    expect(playEvents).toEqual([]);
  });

  it("does nothing extra when WhatsApp's sound comes in time", async () => {
    bridgeSays(PLAY);
    new win.Notification("Radwa", { tag: "601@lid" });
    clock.t += 20;
    await new win.HTMLMediaElement(INCOMING).play();
    vi.advanceTimersByTime(2_000);
    expect(playEvents).toHaveLength(1);
  });

  it("does not play for a silent decision", () => {
    bridgeSays({ action: "silent" });
    new win.Notification("a");
    vi.advanceTimersByTime(2_000);
    expect(playEvents).toEqual([]);
  });

  it("does not play for a native decision", () => {
    bridgeSays({ action: "native" });
    new win.Notification("a");
    vi.advanceTimersByTime(2_000);
    expect(playEvents).toEqual([]);
  });

  it("does not report the notification as silent once it played the sound itself", () => {
    bridgeSays(PLAY);
    new win.Notification("Radwa");
    vi.advanceTimersByTime(2_000);
    expect(signals.filter((s) => s.type === "silent")).toEqual([]);
  });

  it("counts a self-played sound as working on the status line", () => {
    const health = applySignal(emptyHealth(), { type: "self-played" }, 7);
    expect(healthStatus(health)).toMatchObject({ code: "working", at: 7 });
    expect(health.shapes.sound.via).toBe("self");
  });
});
