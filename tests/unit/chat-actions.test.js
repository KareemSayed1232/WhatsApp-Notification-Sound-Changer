import { describe, it, expect, beforeEach } from "vitest";
import { createStateStore } from "../../src/core/state-store.mjs";
import { addChatByName, applyChoice } from "../../src/ui/chat-actions.mjs";
import { buildChatRows } from "../../src/ui/view-model.mjs";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";

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

const rowFor = async (key) => buildChatRows(await store.load()).find((r) => r.key === key);
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
    await applyChoice(store, await rowFor("chat|601@lid"), "id1");
    expect((await store.load()).rules[0]).toMatchObject({
      kind: "chat",
      match: "Radwa",
      chatId: "601@lid",
      action: "sound",
      soundId: "id1",
      enabled: true,
    });
  });

  it("creates a name-based rule for a person inside a group", async () => {
    await applyChoice(store, await rowFor("sender|bob"), "__silent");
    expect((await store.load()).rules[0]).toMatchObject({
      kind: "sender",
      match: "Bob",
      chatId: null,
      action: "silent",
    });
  });

  it("updates the existing rule when the sound changes", async () => {
    await applyChoice(store, await rowFor("chat|601@lid"), "id1");
    await applyChoice(store, await rowFor("chat|601@lid"), "__silent");
    const { rules } = await store.load();
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe("silent");
  });

  it("removes the chat's rule when it goes back to the default sound", async () => {
    await applyChoice(store, await rowFor("chat|601@lid"), "id1");
    await applyChoice(store, await rowFor("chat|601@lid"), "__default");
    expect((await store.load()).rules).toEqual([]);
  });

  it("does nothing when a chat with no rule is set to the default", async () => {
    await applyChoice(store, await rowFor("chat|601@lid"), "__default");
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
    await applyChoice(store, await rowFor("chat|601@lid"), "id1");
    expect((await store.load()).rules.find((r) => r.id === rule.id)).toMatchObject({
      enabled: true,
      action: "sound",
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
