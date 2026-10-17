import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadScript, freshDocument } from "../helpers/load-script.js";

let listener;
let chrome;
let doc;
let audios;

class FakeAudio {
  constructor() {
    this.src = "";
    this.currentTime = 5;
    this.handlers = {};
    this.play = vi.fn(() => Promise.resolve());
    this.pause = vi.fn();
    audios.push(this);
  }
  addEventListener(name, fn) {
    this.handlers[name] = fn;
  }
}

beforeEach(() => {
  audios = [];
  doc = freshDocument();
  chrome = {
    runtime: {
      onMessage: { addListener: (fn) => (listener = fn) },
      sendMessage: vi.fn(),
    },
  };
  loadScript("audio_player/audio-player.js", { chrome, document: doc, Audio: FakeAudio });
  doc.dispatchEvent(new Event("DOMContentLoaded"));
});

describe("audio-player.js (offscreen document)", () => {
  it("plays the audio it is asked to play", () => {
    listener({ title: "WANSC-Play-Sound", audio: "data:audio/mp3;base64,AAAA" });
    expect(audios).toHaveLength(1);
    expect(audios[0].src).toBe("data:audio/mp3;base64,AAAA");
    expect(audios[0].play).toHaveBeenCalled();
  });

  it("reports Audio-Ended when playback finishes", () => {
    listener({ title: "WANSC-Play-Sound", audio: "x" });
    audios[0].handlers.ended();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ title: "WANSC-Audio-Ended" });
  });

  it("stops playback, rewinds, and reports Audio-Ended on Stop-Sound", () => {
    listener({ title: "WANSC-Play-Sound", audio: "x" });
    listener({ title: "WANSC-Stop-Sound" });
    expect(audios[0].pause).toHaveBeenCalled();
    expect(audios[0].currentTime).toBe(0);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ title: "WANSC-Audio-Ended" });
  });

  it("ignores Stop-Sound when nothing is playing", () => {
    listener({ title: "WANSC-Stop-Sound" });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
