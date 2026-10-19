import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { startBridge } from "../../src/content/bridge.mjs";
import { installMainHook } from "../../src/content/main-hook.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PING,
  EVENT_PLAY_NATIVE,
  EVENT_PONG,
  KNOWN_INCOMING_SOUND_URL,
} from "../../src/core/protocol.mjs";

// The same behaviour on every browser while WhatsApp is focused (owner's requirement, Oct 2026).
// Measured: Edge's WhatsApp plays its own sound for a focused message (no notification, so no chat
// is known); Firefox's WhatsApp plays nothing. Either way the extension now finds the chat from its
// unread counter and plays: the chat's sound, else the default sound, else WhatsApp's own ding.

const RENAMED = "https://static.whatsapp.net/rsrc.php/zZ/r/NewDing.ogg";

// ------------------------------------------------------------------ the hook plays the ding

describe("the hook plays WhatsApp's own ding when asked", () => {
  let doc;
  let win;
  let hook;
  let played;
  let asks;
  let store;

  class FakeMedia {
    constructor(src) {
      this.src = src;
      this.currentSrc = src;
      this.isConnected = false;
    }
    play() {
      played.push(this.src);
      return Promise.resolve();
    }
  }

  function install() {
    hook = installMainHook({ window: win, document: doc });
  }

  beforeEach(() => {
    played = [];
    asks = [];
    store = {};
    doc = freshDocument();
    doc.addEventListener(EVENT_ASK, (e) => asks.push(JSON.parse(e.detail)));
    win = {
      Notification: class {
        static permission = "denied";
      },
      HTMLMediaElement: FakeMedia,
      Audio: FakeMedia,
      CustomEvent,
      localStorage: {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => (store[k] = String(v)),
      },
    };
    install();
  });
  afterEach(() => hook?.uninstall());

  const askForDing = () => doc.dispatchEvent(new CustomEvent(EVENT_PLAY_NATIVE));

  it("plays WhatsApp's known incoming sound, without our own hook stepping in", () => {
    askForDing();
    expect(played).toEqual([KNOWN_INCOMING_SOUND_URL]);
    expect(asks).toEqual([]); // it did not ask the bridge about its own ding
  });

  it("uses the sound WhatsApp itself last played, if WhatsApp renamed it", async () => {
    // WhatsApp plays its (renamed) sound after a notification: the hook remembers it.
    doc.addEventListener(EVENT_ASK, (e) => {
      if (JSON.parse(e.detail).kind === "notification") {
        doc.dispatchEvent(
          new CustomEvent(EVENT_ANSWER, {
            detail: JSON.stringify({ mode: "managed", decision: { action: "native" } }),
          })
        );
      }
    });
    new win.Notification("Radwa", { tag: "1@lid", silent: true });
    await new FakeMedia(RENAMED).play();
    played = [];
    askForDing();
    expect(played).toEqual([RENAMED]);
  });

  it("remembers that sound across a page reload", () => {
    store.wanscSoundUrl = RENAMED;
    hook.uninstall();
    install();
    askForDing();
    expect(played).toEqual([RENAMED]);
  });

  it("never plays something that is not a WhatsApp sound, even if storage was tampered with", () => {
    store.wanscSoundUrl = "https://evil.example.com/x.mp3";
    hook.uninstall();
    install();
    askForDing();
    expect(played).toEqual([KNOWN_INCOMING_SOUND_URL]);
  });

  it("does nothing (and does not throw) where the page has no Audio", () => {
    hook.uninstall();
    delete win.Audio;
    install();
    expect(() => askForDing()).not.toThrow();
    expect(played).toEqual([]);
  });

  it("stops listening once uninstalled", () => {
    hook.uninstall();
    askForDing();
    expect(played).toEqual([]);
  });
});

// ------------------------------------------------------------------ the bridge decides

describe("the bridge gives focused messages the same sound on every browser", () => {
  const sounds = {
    s1: { id: "s1", name: "Default", mime: "audio/mpeg", size: 3 },
    s2: { id: "s2", name: "Radwa", mime: "audio/mpeg", size: 3 },
  };
  const radwaRule = (action = "sound") => ({
    id: "r1",
    kind: "chat",
    match: "Radwa",
    chatId: "1@lid",
    action,
    soundId: action === "sound" ? "s2" : null,
    enabled: true,
  });
  let doc;
  let bridge;
  let engine;
  let dings;
  let focused;

  let logged;
  async function boot({
    defaultSoundId = null,
    canPlay = true,
    rules = [radwaRule()],
    played = true,
  } = {}) {
    logged = [];
    const data = {
      settings: { enabled: true, volume: 1, defaultSoundId, showPopups: false },
      sounds,
      rules,
    };
    doc = freshDocument();
    doc.addEventListener(EVENT_PING, () =>
      doc.dispatchEvent(
        new CustomEvent(EVENT_PONG, { detail: JSON.stringify({ notification: true, play: true }) })
      )
    );
    dings = 0;
    doc.addEventListener(EVENT_PLAY_NATIVE, () => (dings += 1));
    engine = { play: vi.fn(async () => played), invalidate: vi.fn(), canPlay: () => canPlay };
    bridge = startBridge({
      chrome: {
        storage: {
          local: {
            get: vi.fn(async (keys) =>
              Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))
            ),
            set: vi.fn(async () => {}),
          },
          onChanged: { addListener: () => {}, removeListener: () => {} },
        },
        runtime: { id: "ext", sendMessage: vi.fn(async () => ({ ok: true })) },
      },
      document: doc,
      engine,
      CustomEventCtor: CustomEvent,
      isFocused: () => focused,
      log: (...args) => logged.push(args.map(String).join(" ")),
    });
    await bridge.ready;
  }

  /** WhatsApp (Edge) plays its own sound while focused: the hook asks what to do. */
  function whatsappPlaysItsSound() {
    let answer = null;
    const onAnswer = (e) => (answer = JSON.parse(e.detail));
    doc.addEventListener(EVENT_ANSWER, onAnswer);
    doc.dispatchEvent(
      new CustomEvent(EVENT_ASK, { detail: JSON.stringify({ kind: "default-sound" }) })
    );
    doc.removeEventListener(EVENT_ANSWER, onAnswer);
    return answer;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    focused = true;
  });
  afterEach(() => {
    bridge?.stop();
    vi.useRealTimers();
  });

  describe("Edge: WhatsApp plays its own sound while focused", () => {
    it("holds WhatsApp's sound back, so the chat's own sound can play instead", async () => {
      await boot();
      expect(whatsappPlaysItsSound().decision).toEqual({ action: "silent" });
    });

    it("plays the chat's own sound as soon as the chat is known (no extra wait)", async () => {
      await boot({ defaultSoundId: "s1" });
      whatsappPlaysItsSound();
      bridge.onIncomingChat("Radwa");
      await vi.advanceTimersByTimeAsync(50);
      expect(engine.play).toHaveBeenCalledWith("s2", 1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(engine.play).toHaveBeenCalledTimes(1); // the held sound is not played as well
      expect(dings).toBe(0);
    });

    it("plays the default sound for a chat without its own", async () => {
      await boot({ defaultSoundId: "s1" });
      whatsappPlaysItsSound();
      bridge.onIncomingChat("Mom");
      await vi.advanceTimersByTimeAsync(50);
      expect(engine.play).toHaveBeenCalledWith("s1", 1);
    });

    it("plays WhatsApp's ding for a chat without a sound when there is no default", async () => {
      await boot();
      whatsappPlaysItsSound();
      bridge.onIncomingChat("Mom");
      await vi.advanceTimersByTimeAsync(50);
      expect(engine.play).not.toHaveBeenCalled();
      expect(dings).toBe(1);
    });

    it("if no chat turns up (e.g. the message is in the open chat), plays what it held", async () => {
      await boot({ defaultSoundId: "s1" });
      whatsappPlaysItsSound();
      await vi.advanceTimersByTimeAsync(1_400);
      expect(engine.play).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(engine.play).toHaveBeenCalledWith("s1", 1);
    });

    it("…or WhatsApp's ding, when there is no default sound", async () => {
      await boot();
      whatsappPlaysItsSound();
      await vi.advanceTimersByTimeAsync(1_600);
      expect(dings).toBe(1);
    });

    it("does not hold anything when our audio cannot start yet (WhatsApp's sound plays as before)", async () => {
      await boot({ canPlay: false });
      expect(whatsappPlaysItsSound().decision).toEqual({ action: "native" });
    });

    it("does not hold anything in the background: that path is unchanged", async () => {
      await boot({ defaultSoundId: "s1" });
      focused = false;
      expect(whatsappPlaysItsSound().decision).toMatchObject({ action: "play", soundId: "s1" });
    });
  });

  describe("saying what happened to the sound (wanscDebug)", () => {
    it("says when the browser is still blocking audio", async () => {
      await boot({ canPlay: false });
      bridge.onIncomingChat("Radwa");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(logged.some((l) => /blocks audio/.test(l))).toBe(true);
    });

    it("says when the sound started", async () => {
      await boot();
      bridge.onIncomingChat("Radwa");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(logged.some((l) => /playback of s2 started/.test(l))).toBe(true);
    });

    it("says when the sound failed", async () => {
      await boot({ played: false });
      bridge.onIncomingChat("Radwa");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(logged.some((l) => /playback of s2 FAILED/.test(l))).toBe(true);
    });

    it("says when it plays WhatsApp's own ding", async () => {
      await boot();
      bridge.onIncomingChat("Mom");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(logged.some((l) => /WhatsApp's own sound/.test(l))).toBe(true);
    });
  });

  describe("Firefox: WhatsApp plays nothing while focused", () => {
    it("plays the chat's own sound", async () => {
      await boot();
      bridge.onIncomingChat("Radwa");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(engine.play).toHaveBeenCalledWith("s2", 1);
    });

    it("plays WhatsApp's ding for a chat without a sound when there is no default", async () => {
      await boot();
      bridge.onIncomingChat("Mom");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(engine.play).not.toHaveBeenCalled();
      expect(dings).toBe(1);
    });

    it("plays nothing for a silent chat", async () => {
      await boot({ rules: [radwaRule("silent")] });
      bridge.onIncomingChat("Radwa");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(engine.play).not.toHaveBeenCalled();
      expect(dings).toBe(0);
    });
  });
});
