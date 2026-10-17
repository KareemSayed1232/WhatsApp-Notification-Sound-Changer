import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadScript, freshDocument, readSource } from "../helpers/load-script.js";

let doc;
let store;
let chrome;

function makeChrome() {
  return {
    runtime: { sendMessage: vi.fn() },
    storage: {
      local: {
        get: vi.fn((keys, cb) => {
          const out = {};
          for (const key of keys) if (key in store) out[key] = store[key];
          cb(out);
        }),
        set: vi.fn((items, cb) => {
          Object.assign(store, items);
          if (cb) cb();
        }),
        remove: vi.fn((keys, cb) => {
          for (const key of [].concat(keys)) delete store[key];
          if (cb) cb();
        }),
        clear: vi.fn((cb) => {
          store = {};
          if (cb) cb();
        }),
      },
    },
  };
}

function boot() {
  doc = freshDocument(readSource("popup.html"));
  doc.getElementById("audioElement").load = vi.fn();
  loadScript("scripts/popup.js", { chrome, document: doc });
}

function upload(file) {
  const input = doc.getElementById("audioFileUpload");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  store = {};
  chrome = makeChrome();
});

describe("popup.js", () => {
  it("hides the stop button and shows no delete button when no sound is stored", () => {
    boot();
    expect(doc.getElementById("stopSoundButton").style.display).toBe("none");
    expect(doc.getElementById("deleteSoundButton")).toBeNull();
  });

  it("loads a stored sound into the player and shows stop/delete controls", () => {
    store.uploadedAudio = "data:audio/mp3;base64,AAAA";
    boot();
    const source = doc.querySelector("#audioElement source");
    expect(source.getAttribute("src")).toBe("data:audio/mp3;base64,AAAA");
    expect(doc.getElementById("deleteSoundButton")).not.toBeNull();
    expect(doc.getElementById("stopSoundButton").style.display).toBe("");
  });

  it("stores an uploaded file as a data URL", async () => {
    boot();
    upload(new File(["abc"], "ping.mp3", { type: "audio/mpeg" }));
    await vi.waitFor(() => expect(store.uploadedAudio).toMatch(/^data:audio\/mpeg;base64,/));
    expect(doc.getElementById("deleteSoundButton")).not.toBeNull();
  });

  it("the stop button pauses the sample and asks the background to stop", () => {
    store.uploadedAudio = "data:audio/mp3;base64,AAAA";
    boot();
    const audio = doc.getElementById("audioElement");
    audio.pause = vi.fn();
    doc.getElementById("stopSoundButton").click();
    expect(audio.pause).toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ title: "WANSC-Stop-Sound" });
  });

  it("removing the sound deletes only the sound, never other stored settings", () => {
    store.uploadedAudio = "data:audio/mp3;base64,AAAA";
    store.someOtherSetting = "keep me";
    boot();
    doc.getElementById("deleteSoundButton").click();
    expect(store.uploadedAudio).toBeUndefined();
    expect(store.someOtherSetting).toBe("keep me");
    expect(chrome.storage.local.clear).not.toHaveBeenCalled();
    expect(doc.getElementById("deleteSoundButton")).toBeNull();
  });
});
