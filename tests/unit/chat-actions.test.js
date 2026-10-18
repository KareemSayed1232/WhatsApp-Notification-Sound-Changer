import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStateStore } from "../../src/core/state-store.mjs";
import {
  addChatByName,
  applyChoice,
  describeScan,
  refreshChatsFromWhatsApp,
} from "../../src/ui/chat-actions.mjs";
import { buildChatRows, buildPeopleRows } from "../../src/ui/view-model.mjs";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";
import { MSG_SCAN } from "../../src/core/protocol.mjs";

let store;
let storage;
let counter;

const sound = (name) => ({
  name,
  type: "audio/mpeg",
  size: 3,
  arrayBuffer: async () => new Uint8Array(3).buffer,
});

const recentSenders = [
  { name: "Radwa", kind: "chat", chatId: "601@lid", lastSeen: 3 },
  { name: "Bob", kind: "sender", lastSeen: 1 },
];

async function setup(initial = { recentSenders }) {
  storage = createFakeStorage(initial);
  counter = 0;
  store = createStateStore({
    storage,
    soundStore: createFakeSoundStore(),
    generateId: () => `id${++counter}`,
    now: () => 1,
  });
  await store.addSound(sound("Ping.mp3")); // id1
}

const chatRow = async (name) => buildChatRows(await store.load()).find((r) => r.name === name);
const personRow = async (name) => buildPeopleRows(await store.load()).find((r) => r.name === name);
const codeOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return null;
};

beforeEach(() => setup());

describe("applyChoice", () => {
  it("creates a rule bound to the chat id when a chat gets its first sound", async () => {
    await applyChoice(store, await chatRow("Radwa"), "id1");
    expect((await store.load()).rules[0]).toMatchObject({
      kind: "chat",
      match: "Radwa",
      chatId: "601@lid",
      action: "sound",
      soundId: "id1",
      enabled: true,
    });
  });

  it("creates a name-based chat rule for a chat read from WhatsApp's list (no id known)", async () => {
    await setup({ knownChats: [{ name: "Mom" }] });
    await applyChoice(store, await chatRow("Mom"), "__silent");
    expect((await store.load()).rules[0]).toMatchObject({
      kind: "chat",
      match: "Mom",
      chatId: null,
      action: "silent",
    });
  });

  it("creates a name-based rule for a person inside a group", async () => {
    await applyChoice(store, await personRow("Bob"), "__silent");
    expect((await store.load()).rules[0]).toMatchObject({
      kind: "sender",
      match: "Bob",
      chatId: null,
      action: "silent",
    });
  });

  it("updates the existing rule when the sound changes", async () => {
    await applyChoice(store, await chatRow("Radwa"), "id1");
    await applyChoice(store, await chatRow("Radwa"), "__silent");
    const { rules } = await store.load();
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe("silent");
  });

  it("removes the chat's rule when it goes back to the default sound", async () => {
    await applyChoice(store, await chatRow("Radwa"), "id1");
    await applyChoice(store, await chatRow("Radwa"), "__default");
    expect((await store.load()).rules).toEqual([]);
  });

  it("does nothing when a chat with no rule is set to the default", async () => {
    await applyChoice(store, await chatRow("Radwa"), "__default");
    expect((await store.load()).rules).toEqual([]);
  });

  it("switches a rule back on if an older version had turned it off", async () => {
    const rule = await store.addRule({
      kind: "chat",
      match: "Radwa",
      chatId: "601@lid",
      action: "silent",
      enabled: false,
    });
    await applyChoice(store, await chatRow("Radwa"), "id1");
    expect((await store.load()).rules.find((r) => r.id === rule.id)).toMatchObject({
      enabled: true,
      action: "sound",
    });
  });

  describe("a contact that reaches us under several chat ids", () => {
    beforeEach(() =>
      setup({
        recentSenders: [
          { name: "Mohanad", kind: "chat", chatId: "111@lid", lastSeen: 3 },
          { name: "Mohanad", kind: "chat", chatId: "222@c.us", lastSeen: 2 },
        ],
      })
    );

    it("is one row, and a choice covers every id", async () => {
      expect(buildChatRows(await store.load())).toHaveLength(1);
      await applyChoice(store, await chatRow("Mohanad"), "id1");
      const { rules } = await store.load();
      expect(rules.map((r) => r.chatId).sort()).toEqual(["111@lid", "222@c.us"]);
      expect(rules.every((r) => r.soundId === "id1")).toBe(true);
    });

    it("changing it again updates both, and the default removes both", async () => {
      await applyChoice(store, await chatRow("Mohanad"), "id1");
      await applyChoice(store, await chatRow("Mohanad"), "__silent");
      expect((await store.load()).rules.every((r) => r.action === "silent")).toBe(true);
      await applyChoice(store, await chatRow("Mohanad"), "__default");
      expect((await store.load()).rules).toEqual([]);
    });
  });
});

describe("addChatByName", () => {
  it("binds a name that matches a seen chat to its chat id, ignoring case", async () => {
    await addChatByName(store, await store.load(), "  radwa ", "id1");
    expect((await store.load()).rules[0]).toMatchObject({
      kind: "chat",
      match: "radwa",
      chatId: "601@lid",
      soundId: "id1",
    });
  });

  it("makes a name-only chat rule for an unknown name", async () => {
    await addChatByName(store, await store.load(), "Mom", "__silent");
    expect((await store.load()).rules[0]).toMatchObject({
      kind: "chat",
      match: "Mom",
      chatId: null,
      action: "silent",
    });
  });

  it("treats a name seen only as a group sender as a sender rule", async () => {
    await addChatByName(store, await store.load(), "bob", "id1");
    expect((await store.load()).rules[0]).toMatchObject({ kind: "sender", chatId: null });
  });

  it("reports a duplicate and an empty name through the store's error codes", async () => {
    await addChatByName(store, await store.load(), "Mom", "__silent");
    expect(await codeOf(addChatByName(store, await store.load(), "mom", "__silent"))).toBe(
      "duplicate-rule"
    );
    expect(await codeOf(addChatByName(store, await store.load(), "   ", "__silent"))).toBe(
      "empty-match"
    );
  });
});

describe("refreshChatsFromWhatsApp", () => {
  const waTab = (over = {}) => ({ id: 5, active: true, ...over });
  const makeChrome = (over = {}) => ({
    tabs: {
      query: vi.fn(async () => [waTab()]),
      sendMessage: vi.fn(async () => ({ ok: true, count: 12 })),
      update: vi.fn(async () => {}),
      getCurrent: vi.fn(async () => ({ id: 9 })),
      ...over,
    },
  });

  it("asks the WhatsApp tab to scan and returns its answer", async () => {
    const chrome = makeChrome();
    expect(await refreshChatsFromWhatsApp(chrome)).toEqual({ ok: true, count: 12 });
    expect(chrome.tabs.query).toHaveBeenCalledWith({ url: "https://web.whatsapp.com/*" });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(5, { type: MSG_SCAN });
    expect(chrome.tabs.update).not.toHaveBeenCalled(); // already in front: no tab switching
  });

  it("says so when there is no WhatsApp tab", async () => {
    const chrome = makeChrome({ query: vi.fn(async () => []) });
    expect(await refreshChatsFromWhatsApp(chrome)).toEqual({ ok: false, reason: "no-tab" });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("explains when the tab has no content script yet (needs a reload)", async () => {
    const chrome = makeChrome({
      sendMessage: vi.fn(async () => {
        throw new Error("Receiving end does not exist");
      }),
    });
    expect(await refreshChatsFromWhatsApp(chrome)).toEqual({ ok: false, reason: "not-ready" });
  });

  it("copes with tabs.query failing or the tab not answering", async () => {
    expect(
      await refreshChatsFromWhatsApp(
        makeChrome({
          query: vi.fn(async () => {
            throw new Error("no access");
          }),
        })
      )
    ).toEqual({ ok: false, reason: "no-access" });
    expect(
      await refreshChatsFromWhatsApp(makeChrome({ sendMessage: vi.fn(async () => undefined) }))
    ).toEqual({ ok: false, reason: "not-ready" });
  });

  it("can bring a background WhatsApp tab to the front for the scan, then go back", async () => {
    const chrome = makeChrome({ query: vi.fn(async () => [waTab({ active: false })]) });
    await refreshChatsFromWhatsApp(chrome, { bringToFront: true });
    expect(chrome.tabs.update).toHaveBeenNthCalledWith(1, 5, { active: true });
    expect(chrome.tabs.update).toHaveBeenNthCalledWith(2, 9, { active: true });
  });

  it("still goes back to the original tab if the scan fails", async () => {
    const chrome = makeChrome({
      query: vi.fn(async () => [waTab({ active: false })]),
      sendMessage: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    await refreshChatsFromWhatsApp(chrome, { bringToFront: true });
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(9, { active: true });
  });

  it("does not switch tabs when the WhatsApp tab is already in front", async () => {
    const chrome = makeChrome();
    await refreshChatsFromWhatsApp(chrome, { bringToFront: true });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe("describeScan", () => {
  it("counts chats", () => {
    expect(describeScan({ ok: true, count: 1 })).toEqual({ text: "Found 1 chat.", kind: "ok" });
    expect(describeScan({ ok: true, count: 42 })).toEqual({ text: "Found 42 chats.", kind: "ok" });
  });

  it("gives a plain reason for each failure", () => {
    expect(describeScan({ ok: false, reason: "no-tab" }).text).toMatch(/Open WhatsApp Web/);
    expect(describeScan({ ok: false, reason: "not-ready" }).text).toMatch(
      /Reload the WhatsApp tab/
    );
    expect(describeScan({ ok: false, reason: "no-chat-list" }).text).toMatch(/Couldn't read/);
    expect(describeScan({ ok: false, reason: "weird" }).kind).toBe("error");
  });
});
