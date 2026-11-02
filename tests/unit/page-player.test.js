import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { startBridge } from "../../src/content/bridge.mjs";
import { installMainHook } from "../../src/content/main-hook.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PING,
  EVENT_PONG,
  EVENT_SOUNDS,
  MSG_GET_SOUND,
} from "../../src/core/protocol.mjs";

// Owner's log: every decision right, "playback started", and yet silence. The sound went through
// a separate audio player (Web Audio in the extension's part of the page) after WhatsApp's own
// was silenced. Now the sounds are handed to WhatsApp's page once, and the hook plays the chosen
// one in a player WhatsApp's page itself creates (checked on the owner's WhatsApp: allowed). If a
// sound is not there, WhatsApp's own ding plays: never silence.

const KNOWN = "https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3";
const DATA_URL = "data:audio/mpeg;base64,AQID"; // bytes 1, 2, 3

describe("the page hook plays your sound in WhatsApp's own kind of player", () => {
  let doc;
  let win;
  let hook;
  let played; // every player that actually started: { src, volume }
  let answer;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = freshDocument();
    played = [];
    class FakeMedia {
      constructor(src = "") {
        this.src = src;
        this.currentSrc = src;
        this.isConnected = false;
        this.volume = 1;
      }
      play() {
        played.push({ src: this.src, volume: this.volume });
        return Promise.resolve();
      }
    }
    let blobs = 0;
    win = {
      Notification: class {
        static permission = "denied";
      },
      HTMLMediaElement: FakeMedia,
      Audio: FakeMedia,
      Blob,
      URL: { createObjectURL: () => `blob:sound-${++blobs}`, revokeObjectURL: vi.fn() },
      CustomEvent,
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id),
    };
    answer = (q) =>
      q.kind === "notification"
        ? { mode: "managed", decision: { action: "play", soundId: "s1", volume: 0.5 } }
        : null;
    doc.addEventListener(EVENT_ASK, (e) => {
      const a = answer(JSON.parse(e.detail));
      if (a) doc.dispatchEvent(new CustomEvent(EVENT_ANSWER, { detail: JSON.stringify(a) }));
    });
    hook = installMainHook({ window: win, document: doc, now: () => Date.now() });
  });
  afterEach(() => {
    hook.uninstall();
    vi.useRealTimers();
  });

  const giveSounds = (sounds) =>
    doc.dispatchEvent(new CustomEvent(EVENT_SOUNDS, { detail: JSON.stringify({ sounds }) }));
  const notify = (options = {}) =>
    new win.Notification("Radwa", { tag: "601@lid", silent: true, ...options });
  const whatsappDings = () => new win.HTMLMediaElement(KNOWN).play();

  it("plays the chat's sound at once, in a page player, and keeps WhatsApp's ding silent", async () => {
    giveSounds([{ id: "s1", dataUrl: DATA_URL }]);
    notify();
    await whatsappDings();
    expect(played).toEqual([{ src: "blob:sound-1", volume: 0.5 }]);
  });

  it("never changes WhatsApp's own sound element (WhatsApp may reuse it)", async () => {
    giveSounds([{ id: "s1", dataUrl: DATA_URL }]);
    notify();
    const ding = new win.HTMLMediaElement(KNOWN);
    await ding.play();
    expect(ding.src).toBe(KNOWN);
  });

  it("a sound not handed over yet: WhatsApp's own ding plays (never silence)", async () => {
    notify();
    await whatsappDings();
    expect(played).toEqual([{ src: KNOWN, volume: 1 }]);
  });

  it("silent means nothing plays", async () => {
    answer = (q) =>
      q.kind === "notification" ? { mode: "managed", decision: { action: "silent" } } : null;
    giveSounds([{ id: "s1", dataUrl: DATA_URL }]);
    notify();
    await whatsappDings();
    expect(played).toEqual([]);
  });

  it("no ding from WhatsApp after a notification meant to ring: the chat's sound plays itself", async () => {
    giveSounds([{ id: "s1", dataUrl: DATA_URL }]);
    notify({ silent: false });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(played).toEqual([{ src: "blob:sound-1", volume: 0.5 }]);
  });

  it("an updated sound replaces the old one, and the old one is released", async () => {
    giveSounds([{ id: "s1", dataUrl: DATA_URL }]);
    giveSounds([{ id: "s1", dataUrl: "data:audio/mpeg;base64,BAUG" }]);
    expect(win.URL.revokeObjectURL).toHaveBeenCalledWith("blob:sound-1");
    notify();
    await whatsappDings();
    expect(played).toEqual([{ src: "blob:sound-2", volume: 0.5 }]);
  });

  it("ignores anything that is not a sound", () => {
    giveSounds([{ id: "x", dataUrl: "data:text/html;base64,PGI+" }, { id: 7 }, null]);
    notify();
    return whatsappDings().then(() => expect(played).toEqual([{ src: KNOWN, volume: 1 }]));
  });

  it("says how many sounds it holds when checked", () => {
    giveSounds([{ id: "s1", dataUrl: DATA_URL }]);
    let pong = null;
    doc.addEventListener(EVENT_PONG, (e) => (pong = JSON.parse(e.detail)));
    doc.dispatchEvent(new CustomEvent(EVENT_PING));
    expect(pong.sounds).toBe(1);
  });
});

describe("the bridge hands the sounds in use to the page", () => {
  let doc;
  let data;
  let bridge;
  let handed;
  let listeners;
  let fetched;

  async function boot() {
    data = {
      settings: { enabled: true, volume: 1, defaultSoundId: "s2", showPopups: false },
      sounds: {
        s1: { id: "s1", name: "Ping", mime: "audio/mpeg", size: 3 },
        s2: { id: "s2", name: "Chime", mime: "audio/mpeg", size: 4 },
        s3: { id: "s3", name: "Spare", mime: "audio/mpeg", size: 5 },
      },
      rules: [
        {
          id: "r1",
          kind: "chat",
          match: "Radwa",
          chatId: "601@lid",
          action: "sound",
          soundId: "s1",
          enabled: true,
        },
      ],
    };
    doc = freshDocument();
    doc.addEventListener(EVENT_PING, () =>
      doc.dispatchEvent(
        new CustomEvent(EVENT_PONG, { detail: JSON.stringify({ notification: true, play: true }) })
      )
    );
    handed = [];
    doc.addEventListener(EVENT_SOUNDS, (e) => handed.push(JSON.parse(e.detail)));
    listeners = [];
    fetched = [];
    bridge = startBridge({
      chrome: {
        storage: {
          local: {
            get: vi.fn(async (keys) =>
              Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))
            ),
            set: vi.fn(async (items) => Object.assign(data, items)),
          },
          onChanged: { addListener: (fn) => listeners.push(fn), removeListener: () => {} },
        },
        runtime: {
          id: "ext",
          sendMessage: vi.fn(async (m) => {
            if (m.type !== MSG_GET_SOUND) return { ok: true };
            fetched.push(m.soundId);
            return { ok: true, dataUrl: `data:audio/mpeg;base64,${btoa(m.soundId)}` };
          }),
        },
      },
      document: doc,
      CustomEventCtor: CustomEvent,
    });
    await bridge.ready;
    await vi.advanceTimersByTimeAsync(0);
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    bridge?.stop();
    vi.useRealTimers();
  });

  const ids = (event) => event.sounds.map((s) => s.id).sort();

  it("hands over every sound a rule or the default uses, once WhatsApp opens", async () => {
    await boot();
    expect(handed).toHaveLength(1);
    expect(ids(handed[0])).toEqual(["s1", "s2"]);
    expect(handed[0].sounds.every((s) => s.dataUrl.startsWith("data:audio/"))).toBe(true);
  });

  it("hands over again when a rule or sound changes", async () => {
    await boot();
    data.rules[0].soundId = "s3";
    for (const fn of listeners) fn({ rules: { newValue: data.rules } }, "local");
    await vi.advanceTimersByTimeAsync(10);
    expect(ids(handed.at(-1))).toEqual(["s2", "s3"]);
  });

  it("needs no audio engine of its own", async () => {
    await boot();
    expect(fetched.sort()).toEqual(["s1", "s2"]);
  });
});
