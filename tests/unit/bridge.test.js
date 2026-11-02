import { describe, it, expect, vi, beforeEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { createSoundLoader, startBridge } from "../../src/content/bridge.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PLAY,
  MSG_GET_SOUND,
  MSG_SEEN,
} from "../../src/core/protocol.mjs";

const sounds = {
  s1: { id: "s1", name: "Ping", mime: "audio/mpeg", size: 3 },
  s2: { id: "s2", name: "Chime", mime: "audio/mpeg", size: 3 },
};
const chatRule = {
  id: "r1",
  kind: "chat",
  match: "Radwa",
  chatId: "601@lid",
  action: "sound",
  soundId: "s2",
  enabled: true,
};

let doc;
let store;
let changeListeners;
let chrome;
let engine;
let bridge;

function makeChrome() {
  changeListeners = [];
  return {
    storage: {
      local: {
        get: vi.fn(async (keys) =>
          Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))
        ),
      },
      onChanged: {
        addListener: (fn) => changeListeners.push(fn),
        removeListener: (fn) => (changeListeners = changeListeners.filter((l) => l !== fn)),
      },
    },
    runtime: { id: "ext", sendMessage: vi.fn(async () => ({ ok: true })) },
  };
}

function ask(payload) {
  let answer = null;
  const onAnswer = (event) => (answer = JSON.parse(event.detail));
  doc.addEventListener(EVENT_ANSWER, onAnswer);
  doc.dispatchEvent(new CustomEvent(EVENT_ASK, { detail: JSON.stringify(payload) }));
  doc.removeEventListener(EVENT_ANSWER, onAnswer);
  return answer;
}

async function boot(overrides = {}) {
  store = {
    settings: { enabled: true, volume: 0.8, defaultSoundId: "s1", showPopups: false },
    sounds,
    rules: [chatRule],
    ...overrides,
  };
  doc = freshDocument();
  chrome = makeChrome();
  engine = { play: vi.fn(), invalidate: vi.fn() };
  bridge = startBridge({ chrome, document: doc, engine, CustomEventCtor: CustomEvent });
  await bridge.ready;
}

const notify = (extra = {}) => ({
  kind: "notification",
  title: "Radwa",
  tag: "601@lid",
  body: "hi",
  ...extra,
});

beforeEach(() => boot());

describe("before the state is loaded", () => {
  it("does not answer, so the hook leaves WhatsApp untouched", () => {
    doc = freshDocument();
    store = {};
    chrome = makeChrome();
    startBridge({ chrome, document: doc, engine, CustomEventCtor: CustomEvent });
    expect(ask({ kind: "permission" })).toBeNull();
  });
});

describe("permission", () => {
  it("spoofs granted when enabled and popups are off", () => {
    expect(ask({ kind: "permission" })).toEqual({ spoof: true });
  });

  it("does not spoof when popups are wanted", async () => {
    await boot({ settings: { enabled: true, showPopups: true } });
    expect(ask({ kind: "permission" })).toEqual({ spoof: false });
  });

  it("does not spoof when the extension is disabled", async () => {
    await boot({ settings: { enabled: false } });
    expect(ask({ kind: "permission" })).toEqual({ spoof: false });
  });
});

describe("notifications", () => {
  it("decides the sound from the rule matching the chat id", () => {
    expect(ask(notify())).toEqual({
      mode: "managed",
      decision: { action: "play", soundId: "s2", volume: 0.8, ruleId: "r1" },
      showPopup: false,
    });
  });

  it("matches by chat id even after the contact is renamed", () => {
    expect(ask(notify({ title: "Brand New Name" })).decision.soundId).toBe("s2");
  });

  it("falls back to the default sound for a chat with no rule", () => {
    expect(ask(notify({ title: "Other", tag: "999@lid" })).decision).toMatchObject({
      action: "play",
      soundId: "s1",
    });
  });

  it("passes everything through when the extension is disabled", async () => {
    await boot({ settings: { enabled: false } });
    expect(ask(notify())).toEqual({ mode: "pass" });
  });

  it("mirrors the popup preference", async () => {
    await boot({ settings: { enabled: true, showPopups: true, defaultSoundId: "s1" } });
    expect(ask(notify()).showPopup).toBe(true);
  });

  it("tolerates malformed questions", () => {
    expect(ask({ kind: "something-else" })).toBeNull();
    doc.dispatchEvent(new CustomEvent(EVENT_ASK, { detail: "not json" }));
    expect(ask({ kind: "notification" }).mode).toBe("managed");
  });
});

describe("default sound", () => {
  it("returns the default decision for a sound with no notification", () => {
    expect(ask({ kind: "default-sound" }).decision).toMatchObject({
      action: "play",
      soundId: "s1",
    });
  });

  it("stays native when disabled", async () => {
    await boot({ settings: { enabled: false } });
    expect(ask({ kind: "default-sound" })).toEqual({ decision: { action: "native" } });
  });
});

describe("reporting seen chats", () => {
  it("reports a 1:1 chat by name and id, never the message text", () => {
    ask(notify({ body: "my secret message" }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: MSG_SEEN,
      items: [{ name: "Radwa", kind: "chat", chatId: "601@lid" }],
    });
    expect(JSON.stringify(chrome.runtime.sendMessage.mock.calls)).not.toContain("secret");
  });

  it("does not report sender-looking prefixes in 1:1 chats", () => {
    ask(notify({ body: "Note: bring milk" }));
    const seen = chrome.runtime.sendMessage.mock.calls.map((c) => c[0]).find((m) => m.items);
    expect(seen.items).toHaveLength(1);
  });

  it("still answers when messaging the background throws or rejects", () => {
    chrome.runtime.sendMessage.mockImplementationOnce(() => {
      throw new Error("Extension context invalidated");
    });
    expect(ask(notify()).mode).toBe("managed");
    chrome.runtime.sendMessage.mockImplementationOnce(() =>
      Promise.reject(new Error("no receiver"))
    );
    expect(ask(notify()).mode).toBe("managed");
  });

  it("does not report anything when disabled", async () => {
    await boot({ settings: { enabled: false } });
    ask(notify());
    const reports = chrome.runtime.sendMessage.mock.calls.map((c) => c[0]).filter((m) => m.items);
    expect(reports).toEqual([]); // only the sounds were fetched, nothing reported
  });
});

describe("playing", () => {
  const play = (detail) => doc.dispatchEvent(new CustomEvent(EVENT_PLAY, { detail }));

  it("ignores malformed play requests", () => {
    play("not json");
    play(JSON.stringify({ soundId: 42 }));
    expect(engine.play).not.toHaveBeenCalled();
  });
});

describe("live updates", () => {
  it("re-reads the state when storage changes, without a page reload", async () => {
    store.rules = [];
    changeListeners.forEach((fn) => fn({ rules: {} }, "local"));
    await vi.waitFor(() => expect(ask(notify()).decision.soundId).toBe("s1"));
  });

  it("ignores changes in other storage areas", () => {
    changeListeners.forEach((fn) => fn({ sounds: {} }, "sync"));
    expect(engine.invalidate).not.toHaveBeenCalled();
  });

  it("keeps working with the sound you changed, with no page reload", async () => {
    store.settings = { ...store.settings, defaultSoundId: "s2" };
    changeListeners.forEach((fn) => fn({ settings: {} }, "local"));
    await vi.waitFor(() =>
      expect(ask({ kind: "default-sound" }).decision).toMatchObject({ soundId: "s2" })
    );
  });

  it("goes quiet once the extension is reloaded under it, instead of using stale rules", () => {
    expect(ask({ kind: "permission" })).toEqual({ spoof: true });
    chrome.runtime = {}; // what a content script sees after the extension is reloaded or updated
    expect(ask({ kind: "permission" })).toBeNull();
    expect(ask(notify())).toBeNull(); // the hook then lets WhatsApp behave natively
  });

  it("ignores play requests after the extension is reloaded under it", () => {
    chrome.runtime = {};
    doc.dispatchEvent(new CustomEvent(EVENT_PLAY, { detail: JSON.stringify({ soundId: "s1" }) }));
    expect(engine.play).not.toHaveBeenCalled();
  });

  it("a newer bridge replaces an older copy left behind in the same tab", async () => {
    store = { ...store, settings: { ...store.settings, defaultSoundId: "s2" } };
    const newerEngine = { play: vi.fn(), invalidate: vi.fn() };
    const newer = startBridge({
      chrome: makeChrome(),
      document: doc,
      engine: newerEngine,
      CustomEventCtor: CustomEvent,
    });
    await newer.ready;

    let answers = 0;
    doc.addEventListener(EVENT_ANSWER, () => answers++);
    expect(ask({ kind: "default-sound" }).decision).toMatchObject({ soundId: "s2" });
    expect(answers).toBe(1); // only the newer copy answered

    newer.stop();
  });

  it("stop() detaches the listeners", () => {
    bridge.stop();
    expect(ask({ kind: "permission" })).toBeNull();
  });
});

describe("debug logging", () => {
  async function bootWithLog() {
    const log = vi.fn();
    doc = freshDocument();
    chrome = makeChrome();
    engine = { play: vi.fn(async () => true), invalidate: vi.fn() };
    const instance = startBridge({
      chrome,
      document: doc,
      engine,
      CustomEventCtor: CustomEvent,
      log,
    });
    await instance.ready;
    return log;
  }

  it("reports the decision for a notification, without the message text", async () => {
    const log = await bootWithLog();
    ask(notify({ body: "very private text" }));
    expect(log).toHaveBeenCalledWith(
      "decision for chat",
      "601@lid",
      "->",
      expect.objectContaining({ action: "play", soundId: "s2" })
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  it("reports the default-sound path used when no notification came first", async () => {
    const log = await bootWithLog();
    ask({ kind: "default-sound" });
    expect(log).toHaveBeenCalledWith(
      "WhatsApp's sound with no notification ->",
      expect.objectContaining({ action: "play", soundId: "s1" })
    );
  });
});

describe("createSoundLoader", () => {
  it("returns the decoded bytes for a stored sound", async () => {
    const loader = createSoundLoader({
      runtime: {
        sendMessage: vi.fn(async () => ({ ok: true, dataUrl: "data:audio/mpeg;base64,AQID" })),
      },
    });
    const sound = await loader("s1");
    expect(sound.mime).toBe("audio/mpeg");
    expect([...sound.bytes]).toEqual([1, 2, 3]);
  });

  it("returns null when the background has no such sound or sends bad data", async () => {
    const send = vi.fn();
    const loader = createSoundLoader({ runtime: { sendMessage: send } });
    send.mockResolvedValueOnce({ ok: false });
    expect(await loader("s1")).toBeNull();
    send.mockResolvedValueOnce({ ok: true, dataUrl: "garbage" });
    expect(await loader("s1")).toBeNull();
    expect(send).toHaveBeenCalledWith({ type: MSG_GET_SOUND, soundId: "s1" });
  });
});
