// @vitest-environment node
// Runs the REAL built bundles (page-world hook + isolated bridge) together in a DOM and plays the
// part of WhatsApp: ask for permission, raise a notification, then play the message mp3.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { build } from "../../scripts/build.mjs";

const INCOMING = "https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3";
const SOUND_BYTES = [1, 2, 3];
const SOUND_DATA_URL = "data:audio/mpeg;base64,AQID";

let outDir;
let hookCode;
let bridgeCode;

beforeAll(async () => {
  outDir = mkdtempSync(path.join(tmpdir(), "wansc-pipeline-"));
  await build("chromium", { outDir });
  hookCode = readFileSync(path.join(outDir, "content/main-hook.js"), "utf8");
  bridgeCode = readFileSync(path.join(outDir, "content/bridge.js"), "utf8");
});

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const settings = (over = {}) => ({
  enabled: true,
  volume: 0.7,
  defaultSoundId: "default",
  showPopups: false,
  ...over,
});
const sounds = {
  default: { id: "default", name: "Default", mime: "audio/mpeg", size: 3 },
  radwa: { id: "radwa", name: "Radwa's", mime: "audio/mpeg", size: 3 },
};
const radwaRule = (over = {}) => ({
  id: "r1",
  kind: "chat",
  match: "Radwa",
  chatId: "601@lid",
  action: "sound",
  soundId: "radwa",
  enabled: true,
  ...over,
});

let window;
let started;
let realNotifications;
let seen;
let soundRequests;
let storage;
let changeListeners;

/** Boots a fresh "WhatsApp tab": fakes for the browser, then the real bundles. */
async function openTab({ stored = {}, realPermission = "denied" } = {}) {
  storage = { settings: settings(), sounds, rules: [radwaRule()], ...stored };
  started = [];
  realNotifications = [];
  seen = [];
  soundRequests = [];
  changeListeners = [];

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://web.whatsapp.com/",
    runScripts: "outside-only",
  });
  window = dom.window;

  window.Notification = class Notification {
    static permission = realPermission;
    static requestPermission() {
      return Promise.resolve(realPermission);
    }
    constructor(title, options) {
      realNotifications.push([title, options]);
    }
  };

  window.AudioContext = class AudioContext {
    state = "running";
    destination = {};
    decodeAudioData(buffer) {
      return Promise.resolve({ bytes: [...new Uint8Array(buffer)] });
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    createBufferSource() {
      const source = { connect() {}, stop() {}, start: () => started.push(source) };
      return source;
    }
    resume() {
      return Promise.resolve();
    }
  };

  window.chrome = {
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries(
            keys.filter((key) => key in storage).map((key) => [key, storage[key]])
          ),
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
    runtime: {
      id: "ext",
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async (message) => {
        if (message.type === "wansc:get-sound") {
          soundRequests.push(message.soundId);
          return { ok: true, dataUrl: SOUND_DATA_URL };
        }
        if (message.type === "wansc:seen") seen.push(...message.items);
        return undefined;
      },
    },
  };

  window.eval(hookCode); // MAIN world, runs first (document_start)
  window.eval(bridgeCode);
  await new Promise((resolve) => window.setTimeout(resolve, 10)); // let the bridge load its state
}

// Real WhatsApp always passes silent: true and plays its own sound (measured, Oct 2026).
const whatsappNotifies = (title, options) =>
  new window.Notification(title, { silent: true, ...options });
const whatsappPlaysMessageSound = () => new window.Audio(INCOMING).play();

beforeEach(() => openTab());

describe("full pipeline with the real bundles", () => {
  it("tells WhatsApp notifications are allowed even though the browser blocks them", () => {
    expect(window.Notification.permission).toBe("granted");
  });

  it("swallows the notification: no desktop popup is ever created", () => {
    const shown = whatsappNotifies("Radwa", { tag: "601@lid", body: "hi", silent: true });
    expect(realNotifications).toEqual([]);
    expect(shown.title).toBe("Radwa");
  });

  it("plays the contact's own sound instead of WhatsApp's", async () => {
    whatsappNotifies("Radwa", { tag: "601@lid", body: "hi", silent: true });
    await whatsappPlaysMessageSound();

    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0].buffer).toEqual({ bytes: SOUND_BYTES });
    expect(soundRequests).toEqual(["radwa"]);
  });

  it("still finds the contact after they are renamed, because it matches the chat id", async () => {
    whatsappNotifies("A Brand New Name", { tag: "601@lid", body: "hi" });
    await whatsappPlaysMessageSound();
    await vi.waitFor(() => expect(soundRequests).toEqual(["radwa"]));
  });

  it("uses the default sound for a chat with no rule", async () => {
    whatsappNotifies("Stranger", { tag: "999@lid", body: "hi" });
    await whatsappPlaysMessageSound();
    await vi.waitFor(() => expect(soundRequests).toEqual(["default"]));
  });

  it("stays silent for a silent rule", async () => {
    await openTab({ stored: { rules: [radwaRule({ action: "silent", soundId: null })] } });
    whatsappNotifies("Radwa", { tag: "601@lid", body: "hi" });
    await whatsappPlaysMessageSound();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(started).toEqual([]);
    expect(soundRequests).toEqual([]);
  });

  it("remembers who messaged, names only", async () => {
    whatsappNotifies("Radwa", { tag: "601@lid", body: "private text" });
    await vi.waitFor(() =>
      expect(seen).toEqual([{ name: "Radwa", kind: "chat", chatId: "601@lid" }])
    );
    expect(JSON.stringify(seen)).not.toContain("private");
  });

  it("applies the default sound when WhatsApp plays the message sound with no notification", async () => {
    await whatsappPlaysMessageSound();
    await vi.waitFor(() => expect(soundRequests).toEqual(["default"]));
  });

  it("does nothing at all while the extension is disabled", async () => {
    await openTab({ stored: { settings: settings({ enabled: false }) } });
    expect(window.Notification.permission).toBe("denied");
    whatsappNotifies("Radwa", { tag: "601@lid" });
    expect(realNotifications).toHaveLength(1); // passed straight through to the browser
    expect(soundRequests).toEqual([]);
  });

  it("shows a real silent popup only when the user opts in and the browser allows it", async () => {
    await openTab({
      stored: { settings: settings({ showPopups: true }) },
      realPermission: "granted",
    });
    whatsappNotifies("Radwa", { tag: "601@lid", body: "hi" });
    expect(realNotifications).toHaveLength(1);
    expect(realNotifications[0][1]).toMatchObject({ tag: "601@lid", silent: true });
  });
});

describe("changing settings while WhatsApp stays open", () => {
  it("uses the new default sound immediately, without reloading the page", async () => {
    await whatsappPlaysMessageSound();
    await vi.waitFor(() => expect(soundRequests).toEqual(["default"]));

    storage.settings = settings({ defaultSoundId: "radwa" });
    changeListeners.forEach((fn) => fn({ settings: {} }, "local"));
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    await whatsappPlaysMessageSound();
    await vi.waitFor(() => expect(soundRequests).toEqual(["default", "radwa"]));
  });

  it("picks up a rule added in the popup straight away", async () => {
    storage.rules = [radwaRule({ action: "silent", soundId: null })];
    changeListeners.forEach((fn) => fn({ rules: {} }, "local"));
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    whatsappNotifies("Radwa", { tag: "601@lid" });
    await whatsappPlaysMessageSound();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(soundRequests).toEqual([]); // silenced
  });
});

describe("after the extension is reloaded or updated", () => {
  it("a copy that lost its extension APIs stops interfering and WhatsApp behaves natively", () => {
    window.chrome.runtime = {}; // exactly what an orphaned content script sees
    expect(window.Notification.permission).toBe("denied"); // no spoofing any more
    whatsappNotifies("Radwa", { tag: "601@lid" });
    expect(realNotifications).toHaveLength(1); // the real notification goes through
  });

  it("a freshly injected bridge takes over with the new settings, and only it answers", async () => {
    storage = { settings: settings({ defaultSoundId: "radwa" }), sounds, rules: [] };
    window.eval(bridgeCode); // what the background does for already-open tabs
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    await whatsappPlaysMessageSound();
    await vi.waitFor(() => expect(soundRequests).toEqual(["radwa"]));
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(started).toHaveLength(1); // the old copy did not also play
  });

  it("injecting the page hook a second time does not break Notification", () => {
    window.eval(hookCode);
    const shown = whatsappNotifies("Radwa", { tag: "601@lid" });
    expect(realNotifications).toEqual([]);
    expect(shown.title).toBe("Radwa");
  });
});
