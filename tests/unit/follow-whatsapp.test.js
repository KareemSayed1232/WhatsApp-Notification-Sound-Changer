import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshDocument } from "../helpers/load-script.js";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";
import { startBridge } from "../../src/content/bridge.mjs";
import { findRebind, findRule } from "../../src/core/matcher.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PING,
  EVENT_PLAY_NATIVE,
  EVENT_PONG,
  MSG_REBIND,
} from "../../src/core/protocol.mjs";
import { createStateStore } from "../../src/core/state-store.mjs";

// The sound logic follows WhatsApp and never guesses from WhatsApp's page.
//
// It reacts only to what WhatsApp itself does through browser functions:
//   1. WhatsApp raises a notification -> it names the chat (tag = the chat's unique id).
//   2. WhatsApp plays its message sound -> a sound is due now.
// Decision table:
//   notification (+ its sound)         -> that chat's rule: its sound / silent / default / WhatsApp's
//   WhatsApp's sound, no notification  -> your default sound, else WhatsApp's own (no chat guessed)
//   WhatsApp does nothing              -> nothing (mutes and @mentions behave exactly as in WhatsApp)
// Nothing on the page (names, unread badges, mute icons) decides a sound.

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (file) => readFileSync(path.resolve(here, "../../src", file), "utf8");

const sounds = {
  s1: { id: "s1", name: "Ping", mime: "audio/mpeg", size: 3 },
  s2: { id: "s2", name: "Chime", mime: "audio/mpeg", size: 4 },
};
const chatRule = (extra = {}) => ({
  id: "r1",
  kind: "chat",
  match: "Radwa",
  chatId: "601@lid",
  action: "sound",
  soundId: "s1",
  enabled: true,
  ...extra,
});

describe("the bridge decides only from WhatsApp's own signals", () => {
  let doc;
  let data;
  let engine;
  let bridge;
  let answers;
  let sent;
  let dings;

  async function boot({ rules = [chatRule()], settings = {}, canPlay = true, played = true } = {}) {
    data = {
      settings: {
        enabled: true,
        volume: 0.7,
        defaultSoundId: null,
        showPopups: false,
        ...settings,
      },
      sounds,
      rules,
    };
    doc = freshDocument();
    doc.addEventListener(EVENT_PING, () =>
      doc.dispatchEvent(
        new CustomEvent(EVENT_PONG, { detail: JSON.stringify({ notification: true, play: true }) })
      )
    );
    answers = [];
    doc.addEventListener(EVENT_ANSWER, (e) => answers.push(JSON.parse(e.detail)));
    dings = 0;
    doc.addEventListener(EVENT_PLAY_NATIVE, () => (dings += 1));
    sent = [];
    engine = {
      play: vi.fn(async () => played),
      invalidate: vi.fn(),
      canPlay: () => canPlay,
      preload: vi.fn(async () => {}),
    };
    bridge = startBridge({
      chrome: {
        storage: {
          local: {
            get: vi.fn(async (keys) =>
              Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))
            ),
            set: vi.fn(async (items) => Object.assign(data, items)),
          },
          onChanged: { addListener: () => {}, removeListener: () => {} },
        },
        runtime: { id: "ext", sendMessage: vi.fn(async (m) => (sent.push(m), { ok: true })) },
      },
      document: doc,
      engine,
      CustomEventCtor: CustomEvent,
    });
    await bridge.ready;
  }
  const ask = (payload) => {
    doc.dispatchEvent(new CustomEvent(EVENT_ASK, { detail: JSON.stringify(payload) }));
    return answers.at(-1);
  };
  const notify = (title, tag, body = "hi") => ask({ kind: "notification", title, tag, body });
  const whatsappSoundWithoutNotification = () => ask({ kind: "default-sound" });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    bridge?.stop();
    vi.useRealTimers();
  });

  it("a notification gets its chat's sound, found by the chat's id", async () => {
    await boot();
    expect(notify("Radwa", "601@lid").decision).toMatchObject({ action: "play", soundId: "s1" });
  });

  it("the chat's id wins over the name: a renamed contact keeps its sound", async () => {
    await boot();
    expect(notify("Radwa (work)", "601@lid").decision).toMatchObject({ soundId: "s1" });
  });

  it("another chat with the same name never gets that sound", async () => {
    await boot({ settings: { defaultSoundId: "s2" } });
    expect(notify("Radwa", "999@lid").decision).toMatchObject({ action: "play", soundId: "s2" });
  });

  it("a silent rule is silent", async () => {
    await boot({ rules: [chatRule({ action: "silent", soundId: null })] });
    expect(notify("Radwa", "601@lid").decision).toMatchObject({ action: "silent" });
  });

  it("WhatsApp's sound with no notification (focused): your default sound, no chat guessed", async () => {
    await boot({ settings: { defaultSoundId: "s2" } });
    expect(whatsappSoundWithoutNotification().decision).toMatchObject({
      action: "play",
      soundId: "s2",
    });
  });

  it("…or WhatsApp's own sound when you have no default", async () => {
    await boot();
    expect(whatsappSoundWithoutNotification().decision).toEqual({ action: "native" });
  });

  it("is answered at once: nothing is held back waiting for the page", async () => {
    await boot({ settings: { defaultSoundId: "s2" } });
    whatsappSoundWithoutNotification();
    expect(answers).toHaveLength(1);
    expect(answers[0].decision.action).not.toBe("silent");
  });

  it("when WhatsApp does nothing, nothing plays: there is no other way to start a sound", async () => {
    await boot({ settings: { defaultSoundId: "s2" } });
    expect(bridge.onIncomingChat).toBeUndefined();
    expect(bridge.onBackgroundChat).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.play).not.toHaveBeenCalled();
  });

  describe("a rule made from a name (Refresh chat list) is tied to the chat's id", () => {
    const named = chatRule({ chatId: null });

    it("at the chat's first notification", async () => {
      await boot({ rules: [named] });
      expect(notify("Radwa", "601@lid").decision).toMatchObject({ soundId: "s1" });
      expect(sent.filter((m) => m.type === MSG_REBIND)).toEqual([
        { type: MSG_REBIND, ruleId: "r1", chatId: "601@lid" },
      ]);
    });

    it("never from a title WhatsApp gives to many chats (not a chat's name)", async () => {
      await boot({ rules: [chatRule({ chatId: null, match: "WhatsApp" })] });
      notify("WhatsApp", "1@lid");
      notify("WhatsApp", "2@lid");
      notify("WhatsApp", "3@lid");
      sent.length = 0;
      notify("WhatsApp", "4@lid");
      expect(sent.filter((m) => m.type === MSG_REBIND)).toEqual([]);
    });
  });
});

describe("rules match by chat id; names only for rules not yet tied to an id", () => {
  it("does not move a rule to a different kind of id by name (no guessing across ids)", () => {
    const rules = [chatRule({ chatId: "201000@c.us", match: "Ahmed" })];
    const notification = { title: "Ahmed", tag: "777@lid" };
    expect(findRule(notification, rules)).toBeNull();
    expect(findRebind(notification, rules)).toBeNull();
  });

  it("person-in-group rules are gone: a group message uses the group's rule", () => {
    const rules = [
      { id: "p", kind: "sender", match: "Radwa", action: "sound", soundId: "s2", enabled: true },
      chatRule({ id: "g", chatId: "120@g.us", match: "Family" }),
    ];
    expect(findRule({ title: "Family", tag: "120@g.us", body: "Radwa: hi" }, rules)?.id).toBe("g");
    expect(findRule({ title: "Other", tag: "121@g.us", body: "Radwa: hi" }, rules)).toBeNull();
  });
});

describe("old person-in-group entries are dropped from storage", () => {
  it("rules and recent entries of the old 'person in a group' kind", async () => {
    const storage = createFakeStorage({
      rules: [
        { id: "p", kind: "sender", match: "Radwa", action: "sound", soundId: null, enabled: true },
        chatRule({ action: "default", soundId: null }),
      ],
      recentSenders: [
        { name: "Radwa", kind: "sender", lastSeen: 2 },
        { name: "Family", kind: "chat", chatId: "120@g.us", lastSeen: 1 },
      ],
    });
    const store = createStateStore({ storage, soundStore: createFakeSoundStore() });
    const state = await store.load();
    expect(state.rules.map((r) => r.id)).toEqual(["r1"]);
    expect(state.recentSenders.map((s) => s.name)).toEqual(["Family"]);
  });
});

describe("nothing on WhatsApp's page decides a sound", () => {
  it("the content script loads no page reader for sounds (only the Refresh chat list collector)", () => {
    const entry = src("content/bridge.entry.mjs");
    for (const gone of ["page-model", "unread-watcher", "mute-learner"]) {
      expect(entry).not.toContain(gone);
    }
    expect(entry).toContain("chat-watcher");
  });

  it("the bridge never reads the page or keeps timing guesses between parts", () => {
    const bridgeSource = src("content/bridge.mjs");
    for (const gone of ["message-ledger", "sound-gate", "chat-identity", "querySelector"]) {
      expect(bridgeSource).not.toContain(gone);
    }
  });
});
