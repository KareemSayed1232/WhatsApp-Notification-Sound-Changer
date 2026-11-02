import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshDocument } from "../helpers/load-script.js";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";
import { startBridge } from "../../src/content/bridge.mjs";
import { applySignal, emptyHealth, healthStatus } from "../../src/core/health.mjs";
import { createStateStore } from "../../src/core/state-store.mjs";
import { healthMessage, mountHealth } from "../../src/ui/health-ui.mjs";
import { mountOptions } from "../../src/ui/options.mjs";
import { mountPopup } from "../../src/ui/popup.mjs";
import { STRINGS as S } from "../../src/ui/strings.mjs";

// What a first-time user needs before 3.0 ships: they can hear a sound without a WhatsApp message
// arriving, Firefox's "click once" is explained before a sound is missed, the same file uploaded
// twice is one sound, and the name, version and support link are right.

const { document, window } = globalThis;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const fire = (element, type) => element.dispatchEvent(new Event(type, { bubbles: true }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

const fakeSound = (name, size = 3) => ({
  name,
  type: "audio/mpeg",
  size,
  arrayBuffer: async () => new Uint8Array(size).buffer,
});

function makeStore(initial = {}) {
  let counter = 0;
  const soundStore = createFakeSoundStore();
  const storage = createFakeStorage(initial);
  const store = createStateStore({
    storage,
    soundStore,
    generateId: () => `id${++counter}`,
    now: () => 1,
  });
  return { store, storage, soundStore };
}

function makeChrome({ tabs = [{ id: 7, windowId: 3, active: false }] } = {}) {
  return {
    tabs: {
      query: vi.fn(async () => tabs),
      update: vi.fn(async () => ({})),
      sendMessage: vi.fn(async () => ({ ok: true, count: 0 })),
    },
    windows: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
    runtime: {
      openOptionsPage: vi.fn(),
      getURL: (p) => `chrome-extension://ext/${p}`,
      getManifest: () => ({ version: "3.0.0" }),
    },
    storage: { onChanged: { addListener: () => {} } },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function bridgeChrome(data) {
  return {
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
  };
}

// ------------------------------------------------------------------ the same sound twice

describe("uploading the same sound twice", () => {
  it("keeps one copy and says it is a duplicate", async () => {
    const { store, soundStore } = makeStore();
    const put = vi.spyOn(soundStore, "put");
    const first = await store.addSound(fakeSound("Ping.mp3"));
    const second = await store.addSound(fakeSound("Ping.mp3"));
    expect(second).toMatchObject({ id: first.id, duplicate: true });
    expect(Object.keys((await store.load()).sounds)).toEqual([first.id]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("still adds a different file, even with the same name", async () => {
    const { store } = makeStore();
    await store.addSound(fakeSound("Ping.mp3", 3));
    const other = await store.addSound(fakeSound("Ping.mp3", 4));
    expect(other.duplicate).toBeUndefined();
    expect(Object.keys((await store.load()).sounds)).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ Firefox: click once

describe("the browser blocking sound until a click", () => {
  it("is its own status, before any sound was missed", () => {
    const h = applySignal(emptyHealth(), { type: "audio", locked: true }, 5);
    expect(healthStatus(h)).toEqual({ code: "audio-locked", level: "warn" });
    expect(healthMessage(h, 10).text).toBe(S.healthAudioLocked);
  });

  it("clears after a click, or once a sound of ours plays", () => {
    const locked = applySignal(emptyHealth(), { type: "audio", locked: true }, 5);
    expect(healthStatus(applySignal(locked, { type: "audio", locked: false }, 6)).code).toBe(
      "waiting"
    );
    expect(healthStatus(applySignal(locked, { type: "played" }, 6)).code).toBe("waiting");
  });

  it("says nothing when sound is allowed", async () => {
    vi.useFakeTimers();
    try {
      const data = { settings: { enabled: true }, sounds: {}, rules: [] };
      const bridge = startBridge({
        chrome: bridgeChrome(data),
        document: freshDocument(),
        engine: { play: vi.fn(), invalidate: vi.fn(), canPlay: () => true },
        CustomEventCtor: CustomEvent,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(data.health?.audioLocked ?? false).toBe(false);
      bridge.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the status line offers to open WhatsApp when a click is needed", () => {
  async function mountWith(health, chrome = makeChrome()) {
    const { store } = makeStore({ health });
    document.body.innerHTML = "";
    document.body.append(mountHealth({ document, stateStore: store, chrome }));
    await settle();
    return chrome;
  }

  it("shows an Open WhatsApp button that brings the WhatsApp tab to the front", async () => {
    const chrome = await mountWith({ audioLocked: true });
    expect($("#openWhatsApp").hidden).toBe(false);
    $("#openWhatsApp").click();
    await vi.waitFor(() => expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true }));
    expect(chrome.windows.update).toHaveBeenCalledWith(3, { focused: true });
  });

  it("also after a sound was blocked", async () => {
    await mountWith({ blockedRun: 1 });
    expect($("#openWhatsApp").hidden).toBe(false);
  });

  it("hides it otherwise", async () => {
    await mountWith({ lastPairedAt: 5 });
    expect($("#openWhatsApp").hidden).toBe(true);
  });
});

// ------------------------------------------------------------------ the popup, first run

async function mountPopupWith({ initial = {}, setup, player } = {}) {
  const { store } = makeStore(initial);
  if (setup) await setup(store);
  document.body.innerHTML = '<div id="app"></div>';
  vi.spyOn(window, "close").mockImplementation(() => {});
  const chrome = makeChrome();
  await mountPopup({ document, stateStore: store, chrome, useUploadWindow: false, player });
  return { store, chrome };
}

const recentSenders = [{ name: "Radwa", kind: "chat", chatId: "601@lid", lastSeen: 3 }];
const search = (query) => {
  $("#chatSearch").value = query;
  fire($("#chatSearch"), "input");
};
const rowOf = (name) => {
  search(name);
  return $$("#chatList li").find((li) => li.querySelector(".name").textContent === name);
};

describe("the popup for a first-time user", () => {
  it("shows the three steps to get started", async () => {
    await mountPopupWith({ initial: { recentSenders } });
    expect($("#firstRun").hidden).toBe(false);
    expect($$("#firstRun li")).toHaveLength(3);
  });

  it("hides them once a default sound is set", async () => {
    await mountPopupWith({
      initial: { recentSenders },
      setup: async (s) => {
        const sound = await s.addSound(fakeSound("Ping.mp3"));
        await s.setSettings({ defaultSoundId: sound.id });
      },
    });
    expect($("#firstRun").hidden).toBe(true);
  });

  it("hides them once a chat has its own sound", async () => {
    await mountPopupWith({
      initial: { recentSenders },
      setup: async (s) => {
        const sound = await s.addSound(fakeSound("Ping.mp3"));
        await s.addRule({ kind: "chat", match: "Radwa", action: "sound", soundId: sound.id });
      },
    });
    expect($("#firstRun").hidden).toBe(true);
  });

  it("names the buttons plainly", async () => {
    await mountPopupWith({ initial: { recentSenders } });
    expect(S.refreshChats).toBe("Refresh chat list");
    expect($("#refreshChats").textContent).toBe(S.refreshChats);
    expect($(".add-by-name summary").textContent).toBe("Can't find a chat? Add it by name");
  });
});

describe("hearing a chat's sound from the popup", () => {
  const withRadwa = async (s) => {
    const sound = await s.addSound(fakeSound("Ping.mp3")); // id1
    await s.addSound(fakeSound("Chime.mp3")); // id2
    await s.setSettings({ defaultSoundId: "id2" });
    await s.addRule({ kind: "chat", match: "Radwa", action: "sound", soundId: sound.id });
  };

  it("plays the chat's own sound", async () => {
    const player = { play: vi.fn(), stop: vi.fn() };
    await mountPopupWith({ initial: { recentSenders }, setup: withRadwa, player });
    rowOf("Radwa").querySelector(".play-sound").click();
    expect(player.play).toHaveBeenCalledWith("id1");
  });

  it("plays the default sound for a chat that uses it", async () => {
    const player = { play: vi.fn(), stop: vi.fn() };
    await mountPopupWith({
      initial: { recentSenders },
      setup: async (s) => {
        await withRadwa(s);
        await s.addRule({ kind: "chat", match: "Mom", action: "default" });
      },
      player,
    });
    rowOf("Mom").querySelector(".play-sound").click();
    expect(player.play).toHaveBeenCalledWith("id2");
  });

  it("has nothing to play for a silent chat", async () => {
    const player = { play: vi.fn(), stop: vi.fn() };
    await mountPopupWith({
      initial: { recentSenders },
      setup: async (s) => s.addRule({ kind: "chat", match: "Radwa", action: "silent" }),
      player,
    });
    expect(rowOf("Radwa").querySelector(".play-sound").disabled).toBe(true);
  });
});

describe("uploading a sound you already added, from the popup", () => {
  it("says so and uses the one you have", async () => {
    await mountPopupWith({
      initial: { recentSenders },
      setup: async (s) => {
        const sound = await s.addSound(fakeSound("Ping.mp3"));
        await s.addRule({ kind: "chat", match: "Radwa", action: "sound", soundId: sound.id });
      },
    });
    const input = rowOf("Radwa").querySelector(".row-file");
    Object.defineProperty(input, "files", { value: [fakeSound("Ping.mp3")], configurable: true });
    fire(input, "change");
    await vi.waitFor(() => expect($("#message").textContent).toMatch(/already added/));
  });
});

// ------------------------------------------------------------------ settings page

describe("the settings page keeps troubleshooting out of the way", () => {
  afterEach(() => vi.restoreAllMocks());

  it("puts diagnostics inside a closed Troubleshooting section", async () => {
    const { store, soundStore } = makeStore();
    document.body.innerHTML = '<div id="app"></div>';
    await mountOptions({ document, stateStore: store, soundStore, chrome: makeChrome() });
    const details = $("#copyDiagnostics").closest("details");
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary").textContent).toBe(S.troubleshooting);
  });
});

// ------------------------------------------------------------------ name, version, support

describe("name, version and support", () => {
  const manifest = readJson("src/manifest.json");
  const pkg = readJson("package.json");
  const REPO = "https://github.com/KareemSayed1232/WhatsApp-Notification-Sound-Changer";

  it("is called Sound Changer for WhatsApp everywhere", () => {
    expect(manifest.name).toBe("Sound Changer for WhatsApp");
    expect(S.appName).toBe(manifest.name);
    for (const page of ["src/ui/popup.html", "src/ui/options.html", "src/ui/upload.html"]) {
      expect(readFileSync(path.join(root, page), "utf8")).not.toMatch(/WhatsApp Sound Changer/);
    }
  });

  it("is version 3.0.0 in the manifest and package.json", () => {
    expect(manifest.version).toBe("3.0.0");
    expect(pkg.version).toBe("3.0.0");
  });

  it("has no author email; support goes through GitHub issues", () => {
    expect(manifest.author).toBeUndefined();
    expect(manifest.homepage_url).toBe(REPO);
    expect(S.supportUrl).toBe(`${REPO}/issues`);
  });

  it("says plainly it is not made by WhatsApp", () => {
    expect(S.notAffiliated).toMatch(/not affiliated with WhatsApp or Meta/i);
  });
});
