import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { startBackground } from "../../src/background/background.mjs";
import { startBridge } from "../../src/content/bridge.mjs";
import { installMainHook } from "../../src/content/main-hook.mjs";
import { applySignal, emptyHealth, healthStatus } from "../../src/core/health.mjs";
import { decidePlayback, findRebind, findRule } from "../../src/core/matcher.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PLAY,
  EVENT_SIGNAL,
  MSG_REBIND,
} from "../../src/core/protocol.mjs";
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
    }).not.toThrow();
  });
});

// ------------------------------------------------------------------ A2

describe("A2: WhatsApp changes the ids it gives chats", () => {
  const sounds = { s1: { id: "s1", name: "Ping" } };
  const oldRule = {
    id: "r1",
    kind: "chat",
    match: "Radwa",
    chatId: "201000@c.us",
    action: "sound",
    soundId: "s1",
    enabled: true,
  };

  describe("matching", () => {
    it("still finds the rule by name when the id changed to a different kind of id", () => {
      const notification = { title: "Radwa", tag: "601@lid" };
      expect(findRule(notification, [oldRule])).toBe(oldRule);
      expect(findRebind(notification, [oldRule])).toEqual({ ruleId: "r1", chatId: "601@lid" });
    });

    it("plays the chat's sound for the new id", () => {
      const decision = decidePlayback({
        notification: { title: "Radwa", tag: "601@lid" },
        rules: [oldRule],
        sounds,
        settings: { enabled: true, volume: 1, defaultSoundId: null },
      });
      expect(decision).toMatchObject({ action: "play", soundId: "s1", ruleId: "r1" });
    });

    it("does not move a rule to another chat with the same kind of id (two people, same name)", () => {
      const notification = { title: "Radwa", tag: "202000@c.us" };
      expect(findRule(notification, [oldRule])).toBeNull();
      expect(findRebind(notification, [oldRule])).toBeNull();
    });

    it("needs both a new id and the same name", () => {
      expect(findRule({ title: "Someone else", tag: "601@lid" }, [oldRule])).toBeNull();
      expect(findRule({ title: "Radwa", tag: "" }, [oldRule])).toBeNull();
      expect(findRebind({ title: "Radwa", tag: "" }, [oldRule])).toBeNull();
    });

    it("prefers an exact id match, and never rebinds then", () => {
      const lidRule = { ...oldRule, id: "r2", chatId: "601@lid", soundId: "s2" };
      const notification = { title: "Radwa", tag: "601@lid" };
      expect(findRule(notification, [oldRule, lidRule])).toBe(lidRule);
      expect(findRebind(notification, [oldRule, lidRule])).toBeNull();
    });

    it("does not rebind a disabled rule, or a rule without an id", () => {
      const notification = { title: "Radwa", tag: "601@lid" };
      expect(findRebind(notification, [{ ...oldRule, enabled: false }])).toBeNull();
      expect(findRebind(notification, [{ ...oldRule, chatId: null }])).toBeNull();
    });
  });

  describe("the bridge", () => {
    let chrome;
    let bridge;
    let bdoc;

    beforeEach(async () => {
      const data = {
        settings: { enabled: true, volume: 1, defaultSoundId: null, showPopups: false },
        sounds,
        rules: [oldRule],
      };
      bdoc = freshDocument();
      chrome = {
        storage: {
          local: {
            get: vi.fn(async (keys) =>
              Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))
            ),
          },
          onChanged: { addListener: () => {}, removeListener: () => {} },
        },
        runtime: { id: "ext", sendMessage: vi.fn(async () => ({ ok: true })) },
      };
      bridge = startBridge({
        chrome,
        document: bdoc,
        engine: { play: vi.fn(), invalidate: vi.fn() },
        CustomEventCtor: CustomEvent,
      });
      await bridge.ready;
    });

    afterEach(() => bridge.stop());

    const ask = (payload) => {
      let answer = null;
      const onAnswer = (event) => (answer = JSON.parse(event.detail));
      bdoc.addEventListener(EVENT_ANSWER, onAnswer);
      bdoc.dispatchEvent(new CustomEvent(EVENT_ASK, { detail: JSON.stringify(payload) }));
      bdoc.removeEventListener(EVENT_ANSWER, onAnswer);
      return answer;
    };

    it("asks the background to move the rule to the new id", () => {
      const answer = ask({ kind: "notification", title: "Radwa", tag: "601@lid", body: "" });
      expect(answer.decision).toMatchObject({ action: "play", soundId: "s1" });
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: MSG_REBIND,
        ruleId: "r1",
        chatId: "601@lid",
      });
    });

    it("does not when the id still matches", () => {
      ask({ kind: "notification", title: "Radwa", tag: "201000@c.us", body: "" });
      const rebinds = chrome.runtime.sendMessage.mock.calls.filter(([m]) => m.type === MSG_REBIND);
      expect(rebinds).toEqual([]);
    });
  });

  describe("the background", () => {
    let listener;
    let stateStore;
    const whatsapp = { id: "ext", url: "https://web.whatsapp.com/", tab: { id: 1 } };

    beforeEach(() => {
      stateStore = {
        load: vi.fn(async () => ({})),
        updateRule: vi.fn(async () => ({})),
        recordSender: vi.fn(async () => {}),
      };
      startBackground({
        chrome: {
          runtime: {
            id: "ext",
            getURL: (p) => `chrome-extension://ext/${p}`,
            onMessage: { addListener: (fn) => (listener = fn) },
            onInstalled: { addListener: () => {} },
            onStartup: { addListener: () => {} },
          },
        },
        stateStore,
        soundStore: { get: vi.fn() },
      });
    });

    it("saves the new id on the rule", () => {
      listener({ type: MSG_REBIND, ruleId: "r1", chatId: "601@lid" }, whatsapp, () => {});
      expect(stateStore.updateRule).toHaveBeenCalledWith("r1", { chatId: "601@lid" });
    });

    it("ignores it from anyone else, or with a malformed id", () => {
      listener({ type: MSG_REBIND, ruleId: "r1", chatId: "601@lid" }, { id: "other" }, () => {});
      for (const chatId of ["no-at-sign", "", 42, null, `${"9".repeat(300)}@lid`]) {
        listener({ type: MSG_REBIND, ruleId: "r1", chatId }, whatsapp, () => {});
      }
      listener({ type: MSG_REBIND, ruleId: 7, chatId: "601@lid" }, whatsapp, () => {});
      expect(stateStore.updateRule).not.toHaveBeenCalled();
    });

    it("survives a rule that no longer exists", async () => {
      stateStore.updateRule.mockRejectedValue(new Error("not-found"));
      expect(() =>
        listener({ type: MSG_REBIND, ruleId: "gone", chatId: "601@lid" }, whatsapp, () => {})
      ).not.toThrow();
    });
  });
});

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
    expect(playEvents).toEqual([{ soundId: "s1", volume: 1 }]);
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
