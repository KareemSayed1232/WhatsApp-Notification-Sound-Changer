import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";
import { startBackground } from "../../src/background/background.mjs";
import { startBridge } from "../../src/content/bridge.mjs";
import { createChatIdentity } from "../../src/core/chat-identity.mjs";
import { applySignal, emptyHealth, healthStatus } from "../../src/core/health.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PING,
  EVENT_PONG,
  MSG_REBIND,
  MSG_SEEN,
} from "../../src/core/protocol.mjs";
import { createStateStore } from "../../src/core/state-store.mjs";
import { healthMessage } from "../../src/ui/health-ui.mjs";
import { STRINGS as S } from "../../src/ui/strings.mjs";
import { buildChatRows } from "../../src/ui/view-model.mjs";

// Phase 2 of the fragility plan: chat identity. Today a group is recognised by its id ending in
// "@g.us", a chat by the notification's title, and a group member by "Sender: text" in the body.
// If WhatsApp changes any of these, things would quietly go wrong; now they are recognised by
// behaviour, and the status line says when WhatsApp stops following them.

// ------------------------------------------------------------------ the tracker

describe("recognising chats by behaviour", () => {
  let identity;
  const see = (title, tag, body = "hi") => identity.observe({ title, tag, body });

  beforeEach(() => {
    identity = createChatIdentity();
  });

  it("a group id is a group, as before", () => {
    expect(see("Family", "120@g.us", "Bob: hi").isGroup).toBe(true);
  });

  it("a chat whose messages come from two different senders is a group, whatever its id", () => {
    expect(see("Family", "777@newformat", "Bob: hi").isGroup).toBe(false);
    const second = see("Family", "777@newformat", "Sara: hello");
    expect(second.isGroup).toBe(true);
    expect(second.newlyGroup).toBe(true);
    expect(see("Family", "777@newformat", "Bob: again").newlyGroup).toBe(false);
    expect(identity.isGroup("777@newformat")).toBe(true);
  });

  it("the same sender twice is not enough", () => {
    see("Mom", "1@lid", "Note: milk");
    expect(see("Mom", "1@lid", "Note: eggs").isGroup).toBe(false);
  });

  it("a 'sender' equal to the chat's own name does not count", () => {
    see("Mom", "1@lid", "Mom: hi");
    expect(see("Mom", "1@lid", "Note: x").isGroup).toBe(false);
  });

  it("remembers groups it was told about (from storage)", () => {
    identity = createChatIdentity({ groups: ["9@lid"] });
    expect(see("Team", "9@lid", "no sender here").isGroup).toBe(true);
  });

  it("notices when notification titles stop being chat names (one title, many chats)", () => {
    expect(see("New message", "1@lid").titlesGeneric).toBe(false);
    expect(see("New message", "2@lid").titlesGeneric).toBe(false);
    expect(see("New message", "3@lid").titlesGeneric).toBe(true);
    expect(see("Radwa", "4@lid").titlesGeneric).toBe(true); // stays flagged this session
  });

  it("two chats that really share a name are fine", () => {
    see("Ahmed", "1@lid");
    expect(see("Ahmed", "2@lid").titlesGeneric).toBe(false);
  });

  it("counts group messages in a row with no 'Sender:' part", () => {
    for (let i = 1; i <= 4; i++) {
      expect(see("Family", "120@g.us", "no sender").senderMissRun).toBe(i);
    }
    expect(see("Family", "120@g.us", "no sender").senderMissRun).toBe(5);
    expect(see("Family", "120@g.us", "Bob: back").senderMissRun).toBe(0);
  });

  it("one-to-one messages never count as missing a sender", () => {
    expect(see("Mom", "1@lid", "no sender").senderMissRun).toBe(0);
  });

  it("copes with missing fields", () => {
    expect(() => identity.observe({})).not.toThrow();
    expect(identity.observe({}).isGroup).toBe(false);
  });
});

// ------------------------------------------------------------------ the status line

describe("saying so on the status line", () => {
  const fold = (signals) => signals.reduce((h, s) => applySignal(h, s, 5), emptyHealth());

  it("warns when notification titles stop being chat names", () => {
    const health = fold([{ type: "titles", generic: true }]);
    expect(healthStatus(health)).toMatchObject({ code: "titles-generic", level: "warn" });
    expect(healthMessage(health, 10).text).toBe(S.healthTitlesGeneric);
    expect(healthStatus(fold([{ type: "titles", generic: false }])).code).toBe("waiting");
  });

  it("warns after 5 group messages in a row without a sender, and clears on the next one", () => {
    const miss = { type: "group-sender", ok: false };
    expect(healthStatus(fold([miss, miss, miss, miss])).code).toBe("waiting");
    const broken = fold([miss, miss, miss, miss, miss]);
    expect(healthStatus(broken)).toMatchObject({ code: "sender-format", level: "warn" });
    expect(healthMessage(broken, 10).text).toBe(S.healthSenderFormat);
    expect(healthStatus(applySignal(broken, { type: "group-sender", ok: true }, 6)).code).toBe(
      "waiting"
    );
  });

  it("a missing hook still outranks both", () => {
    const health = fold([
      { type: "titles", generic: true },
      { type: "hook", state: "missing" },
    ]);
    expect(healthStatus(health).code).toBe("hook-missing");
  });
});

// ------------------------------------------------------------------ the bridge

describe("the bridge uses what it recognised", () => {
  let doc;
  let bridge;
  let chrome;
  let data;
  const rule = {
    id: "r1",
    kind: "chat",
    match: "Mom",
    chatId: "1@c.us",
    action: "sound",
    soundId: "s1",
    enabled: true,
  };

  async function boot(extra = {}) {
    data = {
      settings: { enabled: true, volume: 1, defaultSoundId: null, showPopups: false },
      sounds: { s1: { id: "s1" } },
      rules: [rule],
      ...extra,
    };
    doc = freshDocument();
    doc.addEventListener(EVENT_PING, () =>
      doc.dispatchEvent(
        new CustomEvent(EVENT_PONG, { detail: JSON.stringify({ notification: true, play: true }) })
      )
    );
    chrome = {
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
    bridge = startBridge({
      chrome,
      document: doc,
      engine: { play: vi.fn(), invalidate: vi.fn(), canPlay: () => true },
      CustomEventCtor: CustomEvent,
    });
    await bridge.ready;
  }

  const notify = (title, tag, body = "hi") => {
    let answer = null;
    const onAnswer = (e) => (answer = JSON.parse(e.detail));
    doc.addEventListener(EVENT_ANSWER, onAnswer);
    doc.dispatchEvent(
      new CustomEvent(EVENT_ASK, {
        detail: JSON.stringify({ kind: "notification", title, tag, body }),
      })
    );
    doc.removeEventListener(EVENT_ANSWER, onAnswer);
    return answer;
  };
  const sent = (type) =>
    chrome.runtime.sendMessage.mock.calls.map(([m]) => m).filter((m) => m.type === type);
  const seenItems = () => sent(MSG_SEEN).flatMap((m) => m.items);

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    bridge?.stop();
    vi.useRealTimers();
  });

  it("marks a chat as a group once it is recognised as one, so settings can label it", async () => {
    await boot();
    notify("Family", "777@newformat", "Bob: hi");
    notify("Family", "777@newformat", "Sara: hello");
    expect(
      seenItems()
        .filter((i) => i.kind === "chat")
        .at(-1)
    ).toEqual({
      name: "Family",
      kind: "chat",
      chatId: "777@newformat",
      group: true,
    });
  });

  it("collects senders for a recognised group, even with an id that looks one-to-one", async () => {
    await boot({
      recentSenders: [{ name: "Team", kind: "chat", chatId: "9@lid", group: true, lastSeen: 1 }],
    });
    notify("Team", "9@lid", "Bob: hi");
    expect(seenItems()).toContainEqual({ name: "Bob", kind: "sender" });
  });

  it("when titles stop being chat names: no fake chat is recorded and no rule is moved", async () => {
    await boot();
    notify("New message", "5@lid");
    notify("New message", "6@lid");
    chrome.runtime.sendMessage.mockClear();
    notify("New message", "7@lid");
    expect(seenItems().filter((i) => i.kind === "chat")).toEqual([]);

    // A rule bound to an older kind of id must not be moved by a generic title either.
    notify("Mom", "2@lid");
    expect(sent(MSG_REBIND)).toEqual([]);
  });

  it("still plays id-bound rules while titles are generic", async () => {
    await boot();
    for (const tag of ["5@lid", "6@lid", "7@lid"]) notify("New message", tag);
    expect(notify("New message", "1@c.us").decision).toMatchObject({
      action: "play",
      soundId: "s1",
    });
  });

  it("tells the status line about titles and group senders", async () => {
    await boot();
    for (const tag of ["5@lid", "6@lid", "7@lid"]) notify("New message", tag);
    for (let i = 0; i < 5; i++) notify("Family", "120@g.us", "system text");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(data.health.titlesGeneric).toBe(true);
    expect(data.health.senderMissRun).toBe(5);
  });
});

// ------------------------------------------------------------------ storage and settings

describe("the group flag is stored and shown", () => {
  it("is kept on a recent chat, and stays once known", async () => {
    const store = createStateStore({
      storage: createFakeStorage(),
      soundStore: createFakeSoundStore(),
      now: () => 1,
    });
    await store.recordSender({ name: "Team", kind: "chat", chatId: "9@lid", group: true });
    await store.recordSender({ name: "Team", kind: "chat", chatId: "9@lid" });
    const [entry] = (await store.load()).recentSenders;
    expect(entry).toMatchObject({ name: "Team", chatId: "9@lid", group: true });
  });

  it("only a real true counts", async () => {
    const store = createStateStore({
      storage: createFakeStorage(),
      soundStore: createFakeSoundStore(),
      now: () => 1,
    });
    await store.recordSender({ name: "Mom", kind: "chat", chatId: "1@lid", group: "yes" });
    expect((await store.load()).recentSenders[0].group).toBeUndefined();
  });

  it("the background passes it on", () => {
    let listener;
    const stateStore = { load: vi.fn(async () => ({})), recordSender: vi.fn(async () => {}) };
    startBackground({
      chrome: {
        runtime: {
          id: "ext",
          getURL: (p) => `chrome-extension://ext/${p}`,
          onMessage: { addListener: (fn) => (listener = fn) },
          onInstalled: { addListener: () => {} },
          onStartup: { addListener: () => {} },
        },
      },
      stateStore,
      soundStore: { get: vi.fn() },
    });
    listener(
      { type: MSG_SEEN, items: [{ name: "Team", kind: "chat", chatId: "9@lid", group: true }] },
      { id: "ext", url: "https://web.whatsapp.com/" },
      () => {}
    );
    expect(stateStore.recordSender).toHaveBeenCalledWith({
      name: "Team",
      kind: "chat",
      chatId: "9@lid",
      group: true,
    });
  });

  it("settings label a recognised group 'Group', whatever its id looks like", () => {
    const rows = buildChatRows({
      recentSenders: [{ name: "Team", kind: "chat", chatId: "9@lid", group: true, lastSeen: 1 }],
      knownChats: [],
      rules: [],
      sounds: {},
    });
    expect(rows[0].kindLabel).toBe("Group");
  });

  it("…and still by the old id, as before", () => {
    const rows = buildChatRows({
      recentSenders: [{ name: "Family", kind: "chat", chatId: "120@g.us", lastSeen: 1 }],
      knownChats: [],
      rules: [],
      sounds: {},
    });
    expect(rows[0].kindLabel).toBe("Group");
  });
});
