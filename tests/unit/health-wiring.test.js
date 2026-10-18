import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";
import { startBridge } from "../../src/content/bridge.mjs";
import { findChatPane, readChatNames, scanChatList } from "../../src/content/chat-list.mjs";
import { installMainHook } from "../../src/content/main-hook.mjs";
import { emptyHealth } from "../../src/core/health.mjs";
import {
  EVENT_SIGNAL,
  isKnownIncomingSound,
  isWhatsAppSound,
  soundFileName,
} from "../../src/core/protocol.mjs";
import { createStateStore } from "../../src/core/state-store.mjs";

const INCOMING = "https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3";
const soundsState = { s1: { id: "s1", name: "Ping", mime: "audio/mpeg", size: 3 } };

describe("what counts as a WhatsApp sound", () => {
  it("accepts any audio type on WhatsApp's own hosts", () => {
    for (const file of ["a.mp3", "a.ogg", "a.opus", "a.m4a", "a.wav", "a.aac", "a.webm", "A.MP3"]) {
      expect(isWhatsAppSound(`https://static.whatsapp.net/x/${file}`)).toBe(true);
    }
    expect(isWhatsAppSound("https://web.whatsapp.com/assets/ping.ogg")).toBe(true);
    expect(isWhatsAppSound("https://cdn.static.whatsapp.net/x/a.mp3")).toBe(true);
  });

  it("still refuses look-alike hosts and non-audio files", () => {
    expect(isWhatsAppSound("https://whatsapp.net.evil.com/a.mp3")).toBe(false);
    expect(isWhatsAppSound("https://notwhatsapp.net/a.mp3")).toBe(false);
    expect(isWhatsAppSound("https://static.whatsapp.net/x/a.js")).toBe(false);
    expect(isWhatsAppSound("https://static.whatsapp.net/x/a.mp3.exe")).toBe(false);
  });

  it("reads the file name", () => {
    expect(soundFileName(INCOMING)).toBe("BS_BUUXbKq5.mp3");
    expect(soundFileName("not a url")).toBe("");
  });

  it("knows the measured sound, plus any file it was told to learn", () => {
    const renamed = "https://static.whatsapp.net/x/Learned.ogg";
    expect(isKnownIncomingSound(INCOMING)).toBe(true);
    expect(isKnownIncomingSound(renamed)).toBe(false);
    expect(isKnownIncomingSound(renamed, ["Learned.ogg"])).toBe(true);
    expect(isKnownIncomingSound("https://evil.com/Learned.ogg", ["Learned.ogg"])).toBe(false);
  });
});

describe("loading the status record", () => {
  it("returns an empty record when nothing has been written", async () => {
    const store = createStateStore({
      storage: createFakeStorage(),
      soundStore: createFakeSoundStore(),
    });
    expect(await store.loadHealth()).toEqual(emptyHealth());
  });

  it("sanitises what is stored and is not touched by settings changes", async () => {
    const storage = createFakeStorage({
      health: { notifications: 4, hook: { state: "ok" }, shapes: { tags: ["lid", "<b>"] } },
    });
    const store = createStateStore({ storage, soundStore: createFakeSoundStore() });
    await store.setSettings({ volume: 0.5 });
    const health = await store.loadHealth();
    expect(health.notifications).toBe(4);
    expect(health.hook.state).toBe("ok");
    expect(health.shapes.tags).toEqual(["lid"]);
  });
});

describe("the bridge keeping the status record", () => {
  let doc;
  let win;
  let data;
  let chrome;
  let listeners;
  let bridge;
  let hook;

  function makeChrome() {
    listeners = [];
    return {
      storage: {
        local: {
          get: vi.fn(async (keys) =>
            Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))
          ),
          set: vi.fn(async (items) => Object.assign(data, items)),
        },
        onChanged: {
          addListener: (fn) => listeners.push(fn),
          removeListener: (fn) => (listeners = listeners.filter((l) => l !== fn)),
        },
      },
      runtime: { id: "ext", sendMessage: vi.fn(async () => ({ ok: true })) },
    };
  }

  async function boot({ withHook = true } = {}) {
    data = {
      settings: { enabled: true, volume: 0.8, defaultSoundId: "s1", showPopups: false },
      sounds: soundsState,
      rules: [],
    };
    doc = freshDocument();
    class FakeNotification {
      static permission = "denied";
    }
    class FakeMedia {
      play() {
        return Promise.resolve();
      }
    }
    win = { Notification: FakeNotification, HTMLMediaElement: FakeMedia, CustomEvent };
    if (withHook) hook = installMainHook({ window: win, document: doc });
    chrome = makeChrome();
    bridge = startBridge({
      chrome,
      document: doc,
      engine: { play: vi.fn(), invalidate: vi.fn() },
      CustomEventCtor: CustomEvent,
    });
    await bridge.ready;
  }

  const flush = () => vi.advanceTimersByTimeAsync(1_000);
  // Real WhatsApp always passes silent: true and plays its own sound (measured, Oct 2026).
  const whatsappNotifies = (title, options) =>
    new win.Notification(title, { silent: true, ...options });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    bridge?.stop();
    hook?.uninstall();
    hook = null;
    vi.useRealTimers();
  });

  it("records that the hook is in place", async () => {
    await boot();
    await flush();
    expect(data.health.hook.state).toBe("ok");
  });

  it("records that the hook is missing when nothing answers", async () => {
    await boot({ withHook: false });
    await flush();
    expect(data.health.hook.state).toBe("missing");
  });

  it("notices later when WhatsApp replaces what the hook wrapped", async () => {
    await boot();
    await flush();
    win.Notification = class WhatsAppsOwn {};
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(data.health.hook.state).toBe("overwritten");
  });

  it("counts a notification by the kind of chat id, never the id or the name", async () => {
    await boot();
    whatsappNotifies("Radwa Secret", { tag: "601@lid", body: "private text" });
    await flush();
    expect(data.health.notifications).toBe(1);
    expect(data.health.shapes.tags).toEqual(["lid"]);
    const stored = JSON.stringify(data.health);
    for (const secret of ["Radwa", "601", "private"]) expect(stored).not.toContain(secret);
  });

  it("records what happened to the sound, as a shape", async () => {
    await boot();
    whatsappNotifies("Radwa", { tag: "601@lid" });
    await win.HTMLMediaElement.prototype.play.call({ currentSrc: INCOMING, isConnected: false });
    await flush();
    expect(data.health.paired).toBe(1);
    expect(data.health.silentRun).toBe(0);
    expect(data.health.shapes.sound).toMatchObject({ host: "static.whatsapp.net", ext: "mp3" });
    expect(JSON.stringify(data.health)).not.toContain("rsrc.php");
  });

  it("counts a notification that no sound followed, and warns after several", async () => {
    await boot();
    for (let i = 0; i < 3; i++) {
      whatsappNotifies("Radwa", { tag: "601@lid" });
      await vi.advanceTimersByTimeAsync(1_600);
    }
    await flush();
    expect(data.health.silentRun).toBe(3);
  });

  it("ignores forged or malformed signals from the page", async () => {
    await boot();
    for (const detail of [
      JSON.stringify({ type: "paired", url: "javascript:alert(1)", via: "<x>", detached: "yes" }),
      JSON.stringify({ type: "hook", state: "<script>" }),
      "not json",
      JSON.stringify(42),
    ]) {
      doc.dispatchEvent(new CustomEvent(EVENT_SIGNAL, { detail }));
    }
    await flush();
    const sound = data.health.shapes.sound;
    expect(sound).toEqual({ via: "audio", host: "other", ext: "other", detached: false });
    expect(data.health.hook.state).not.toBe("<script>");
  });

  it("bounds how many signals a page can queue", async () => {
    await boot();
    for (let i = 0; i < 1_000; i++) {
      doc.dispatchEvent(
        new CustomEvent(EVENT_SIGNAL, { detail: JSON.stringify({ type: "silent" }) })
      );
    }
    await flush();
    expect(data.health.silentRun).toBeLessThanOrEqual(100);
  });

  it("does not reload the rules when only the status record changed", async () => {
    await boot();
    await flush();
    const reads = () =>
      chrome.storage.local.get.mock.calls.filter(([keys]) => keys.includes("rules")).length;
    const before = reads();
    for (const listener of listeners) listener({ health: { newValue: {} } }, "local");
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(before);
    for (const listener of listeners) listener({ rules: { newValue: [] } }, "local");
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(before + 1);
  });

  it("stops checking and recording once stopped", async () => {
    await boot();
    await flush();
    bridge.stop();
    chrome.storage.local.set.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    whatsappNotifies("Radwa", { tag: "1@lid" });
    await flush();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("keeps working when status cannot be saved", async () => {
    await boot();
    chrome.storage.local.set.mockRejectedValue(new Error("quota"));
    whatsappNotifies("Radwa", { tag: "601@lid" });
    await flush(); // would reject (or leave an unhandled rejection) if the failure escaped
    expect(chrome.storage.local.set).toHaveBeenCalled();
  });
});

describe("finding WhatsApp's chat list after a markup change", () => {
  const page = (html) => freshDocument(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const row = (name) => `<div role="row"><span dir="auto" title="${name}">${name}</span></div>`;

  it("prefers the known id", () => {
    const doc = page(`<div id="pane-side">${row("Mom")}</div><div aria-label="Chat list"></div>`);
    expect(findChatPane(doc).id).toBe("pane-side");
  });

  it("falls back to a test id or an accessible name when the id disappears", () => {
    expect(
      readChatNames(page(`<div data-testid="chat-list">${row("Mom")}${row("Dad")}</div>`))
    ).toEqual(["Mom", "Dad"]);
    expect(readChatNames(page(`<div aria-label="Chat list">${row("Mom")}</div>`))).toEqual(["Mom"]);
    expect(
      readChatNames(page(`<section aria-label="Your chat list">${row("Mom")}</section>`))
    ).toEqual(["Mom"]);
  });

  it("reports no list when nothing matches", async () => {
    const doc = page("<div>nothing here</div>");
    expect(findChatPane(doc)).toBeNull();
    expect(readChatNames(doc)).toEqual([]);
    expect(await scanChatList({ document: doc, wait: async () => {} })).toMatchObject({
      ok: false,
      reason: "no-chat-list",
    });
  });

  it("scrolls the nearest scrollable parent when the matched element is not the scroller", async () => {
    const doc = page(`<div id="scroller"><div data-testid="chat-list">${row("Mom")}</div></div>`);
    const scroller = doc.getElementById("scroller");
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    const result = await scanChatList({ document: doc, wait: async () => {}, maxSteps: 5 });
    expect(result).toEqual({ ok: true, names: ["Mom"] });
    expect(scroller.scrollTop).toBe(0); // put back where it was
  });
});
