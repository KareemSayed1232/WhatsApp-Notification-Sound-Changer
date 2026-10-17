import { describe, it, expect, vi, beforeEach } from "vitest";
import { startBackground } from "../../src/background/background.mjs";
import { MSG_GET_SOUND, MSG_SEEN } from "../../src/core/protocol.mjs";

const whatsappSender = { id: "ext", url: "https://web.whatsapp.com/", tab: { id: 1 } };
const extensionPage = { id: "ext", url: "chrome-extension://ext/options.html" };

let listener;
let onInstalled;
let onStartup;
let chrome;
let stateStore;
let soundStore;

beforeEach(() => {
  chrome = {
    runtime: {
      id: "ext",
      getURL: (path) => `chrome-extension://ext/${path}`,
      onMessage: { addListener: (fn) => (listener = fn) },
      onInstalled: { addListener: (fn) => (onInstalled = fn) },
      onStartup: { addListener: (fn) => (onStartup = fn) },
    },
    tabs: { query: vi.fn(async () => [{ id: 11 }, { id: 12 }]) },
    scripting: { executeScript: vi.fn(async () => {}) },
  };
  stateStore = {
    load: vi.fn(async () => ({})),
    recordSender: vi.fn(async () => {}),
  };
  soundStore = {
    get: vi.fn(async (id) =>
      id === "s1" ? { mime: "audio/mpeg", data: new Uint8Array([1, 2, 3]).buffer } : null
    ),
  };
  startBackground({ chrome, stateStore, soundStore });
});

/** Calls the message listener the way Chrome does and resolves with the response, if any. */
function send(message, sender = whatsappSender) {
  return new Promise((resolve) => {
    const keepOpen = listener(message, sender, resolve);
    if (keepOpen !== true) resolve(undefined);
  });
}

describe("startup", () => {
  it("loads (and migrates) the state when the worker starts, installs and restarts", () => {
    expect(stateStore.load).toHaveBeenCalledTimes(1);
    onInstalled();
    onStartup();
    expect(stateStore.load).toHaveBeenCalledTimes(3);
  });

  it("survives a failing load", async () => {
    stateStore.load.mockRejectedValue(new Error("idb unavailable"));
    expect(() => onStartup()).not.toThrow();
  });
});

describe("open WhatsApp tabs when the extension is installed, updated or reloaded", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("injects the page hook and a fresh bridge into every open WhatsApp tab", async () => {
    onInstalled({ reason: "update" });
    await flush();
    expect(chrome.tabs.query).toHaveBeenCalledWith({ url: "https://web.whatsapp.com/*" });
    for (const tabId of [11, 12]) {
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId },
        files: ["content/main-hook.js"],
        world: "MAIN",
      });
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId },
        files: ["content/bridge.js"],
      });
    }
  });

  it("does not inject on a plain browser start-up (content scripts load normally then)", async () => {
    onStartup();
    await flush();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("copes with failing injections and with having no tabs", async () => {
    chrome.scripting.executeScript.mockRejectedValue(new Error("tab closed"));
    expect(() => onInstalled({ reason: "install" })).not.toThrow();
    chrome.tabs.query.mockRejectedValue(new Error("no permission"));
    expect(() => onInstalled({ reason: "install" })).not.toThrow();
    chrome.tabs.query.mockResolvedValue([]);
    onInstalled({ reason: "update" });
    await flush();
  });
});

describe("get-sound", () => {
  it("returns the stored sound as a data URL", async () => {
    const response = await send({ type: MSG_GET_SOUND, soundId: "s1" });
    expect(response).toEqual({ ok: true, dataUrl: "data:audio/mpeg;base64,AQID" });
  });

  it("keeps the channel open for the async reply", () => {
    expect(listener({ type: MSG_GET_SOUND, soundId: "s1" }, whatsappSender, () => {})).toBe(true);
  });

  it("answers not-ok for an unknown sound or a storage error", async () => {
    expect(await send({ type: MSG_GET_SOUND, soundId: "gone" })).toEqual({ ok: false });
    soundStore.get.mockRejectedValue(new Error("boom"));
    expect(await send({ type: MSG_GET_SOUND, soundId: "s1" })).toEqual({ ok: false });
  });

  it("serves our own extension pages (for sound previews)", async () => {
    expect((await send({ type: MSG_GET_SOUND, soundId: "s1" }, extensionPage)).ok).toBe(true);
  });

  it("rejects non-string sound ids", async () => {
    expect(await send({ type: MSG_GET_SOUND, soundId: { $ne: 1 } })).toBeUndefined();
    expect(soundStore.get).not.toHaveBeenCalled();
  });
});

describe("sender trust", () => {
  it.each([
    ["another extension", { id: "evil", url: "https://web.whatsapp.com/" }],
    ["another website", { id: "ext", url: "https://example.com/" }],
    ["a look-alike host", { id: "ext", url: "https://web.whatsapp.com.evil.com/" }],
    ["no sender", null], // null, not undefined: the send() helper defaults undefined to a trusted sender
  ])("ignores messages from %s", async (_name, sender) => {
    const response = await send({ type: MSG_GET_SOUND, soundId: "s1" }, sender);
    expect(response).toBeUndefined();
    expect(soundStore.get).not.toHaveBeenCalled();
    await send({ type: MSG_SEEN, items: [{ name: "A", kind: "chat" }] }, sender);
    expect(stateStore.recordSender).not.toHaveBeenCalled();
  });

  it("falls back to the tab url when the frame url is missing", async () => {
    const response = await send(
      { type: MSG_GET_SOUND, soundId: "s1" },
      { id: "ext", tab: { url: "https://web.whatsapp.com/" } }
    );
    expect(response.ok).toBe(true);
  });
});

describe("seen chats", () => {
  it("records each reported chat or sender", async () => {
    await send({
      type: MSG_SEEN,
      items: [
        { name: "Radwa", kind: "chat", chatId: "601@lid" },
        { name: "Bob", kind: "sender" },
      ],
    });
    expect(stateStore.recordSender).toHaveBeenCalledWith({
      name: "Radwa",
      kind: "chat",
      chatId: "601@lid",
    });
    expect(stateStore.recordSender).toHaveBeenCalledWith({
      name: "Bob",
      kind: "sender",
      chatId: undefined,
    });
  });

  it("caps how many items one message may record", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ name: `n${i}`, kind: "chat" }));
    await send({ type: MSG_SEEN, items });
    expect(stateStore.recordSender).toHaveBeenCalledTimes(4);
  });

  it("ignores malformed payloads and swallows write errors", async () => {
    await send({ type: MSG_SEEN, items: "nope" });
    await send({ type: MSG_SEEN, items: [null, 5] });
    expect(stateStore.recordSender).not.toHaveBeenCalled();
    stateStore.recordSender.mockRejectedValue(new Error("quota"));
    await expect(
      send({ type: MSG_SEEN, items: [{ name: "A", kind: "chat" }] })
    ).resolves.toBeUndefined();
  });
});
