import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadScript } from "../helpers/load-script.js";

let listener;
let chrome;
let waTabs;

function makeChrome() {
  return {
    runtime: {
      onMessage: { addListener: (fn) => (listener = fn) },
      sendMessage: vi.fn(() => Promise.resolve()),
    },
    offscreen: {
      hasDocument: vi.fn(() => Promise.resolve(false)),
      closeDocument: vi.fn(),
      createDocument: vi.fn(() => Promise.resolve()),
    },
    tabs: {
      query: vi.fn((_q, cb) => cb(waTabs)),
      update: vi.fn(),
    },
  };
}

beforeEach(() => {
  waTabs = [{ id: 11 }];
  chrome = makeChrome();
  loadScript("scripts/service-worker.js", { chrome });
});

describe("service-worker.js", () => {
  it("registers a runtime message listener", () => {
    expect(typeof listener).toBe("function");
  });

  it("on Load-Player: mutes the tab, creates the offscreen doc, then asks it to play", async () => {
    await listener({ title: "WANSC-Load-Player", audio: "data:audio/mp3;base64,AAAA" });
    expect(chrome.tabs.query).toHaveBeenCalledWith(
      { url: "https://web.whatsapp.com/*" },
      expect.any(Function)
    );
    expect(chrome.tabs.update).toHaveBeenCalledWith(11, { muted: true });
    expect(chrome.offscreen.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "audio_player/audio_player.html",
        reasons: ["AUDIO_PLAYBACK"],
      })
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      title: "WANSC-Play-Sound",
      audio: "data:audio/mp3;base64,AAAA",
    });
  });

  it("closes a stale offscreen document before creating a new one", async () => {
    chrome.offscreen.hasDocument.mockResolvedValue(true);
    await listener({ title: "WANSC-Load-Player", audio: "x" });
    expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
  });

  it("mutes every open WhatsApp tab, not just the first", async () => {
    waTabs = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await listener({ title: "WANSC-Load-Player", audio: "x" });
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { muted: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { muted: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { muted: true });
  });

  it("does not touch tabs when no WhatsApp tab is open", async () => {
    waTabs = [];
    await listener({ title: "WANSC-Load-Player", audio: "x" });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("on Audio-Ended: unmutes every WhatsApp tab", async () => {
    waTabs = [{ id: 1 }, { id: 2 }];
    await listener({ title: "WANSC-Audio-Ended" });
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { muted: false });
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { muted: false });
  });

  it("on Stop-Sound: forwards the stop request to the audio player", async () => {
    await listener({ title: "WANSC-Stop-Sound" });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ title: "WANSC-Stop-Sound" });
  });

  it("ignores unrelated messages", async () => {
    await listener({ title: "something-else" });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
