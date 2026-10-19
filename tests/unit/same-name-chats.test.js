import { describe, it, expect } from "vitest";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";
import { decidePlayback } from "../../src/core/matcher.mjs";
import { createStateStore } from "../../src/core/state-store.mjs";
import { applyChoice } from "../../src/ui/chat-actions.mjs";
import { CHOICE_DEFAULT, buildChatRows } from "../../src/ui/view-model.mjs";

// Two different chats with the same name (two groups called "Family", or a group and a person)
// must be two rows, each with its own sound. One person seen under an old and a new kind of id
// (WhatsApp moved contacts from "@c.us" to "@lid") must stay ONE row.

const NOW = 10_000_000;
const MIN = 60_000;
const sounds = { s1: { id: "s1", name: "Ping" }, s2: { id: "s2", name: "Chime" } };

const seen = (name, chatId, minutesAgo, extra = {}) => ({
  name,
  kind: "chat",
  chatId,
  lastSeen: NOW - minutesAgo * MIN,
  ...extra,
});
const rule = (id, chatId, soundId, extra = {}) => ({
  id,
  kind: "chat",
  match: "Family",
  chatId,
  action: "sound",
  soundId,
  enabled: true,
  ...extra,
});
const rowsOf = (state) => buildChatRows({ knownChats: [], rules: [], sounds, ...state }, "", NOW);

// ------------------------------------------------------------------ rows

describe("one row per real chat", () => {
  it("two groups with the same name are two rows, newest first", () => {
    const rows = rowsOf({
      recentSenders: [seen("Family", "111@g.us", 30), seen("Family", "222@g.us", 2)],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.targets.map((t) => t.chatId))).toEqual([["222@g.us"], ["111@g.us"]]);
    expect(rows[0].key).not.toBe(rows[1].key);
    expect(rows.map((r) => r.kindLabel)).toEqual([
      "Group · last message 2 minutes ago",
      "Group · last message 30 minutes ago",
    ]);
  });

  it("a group and a person with the same name are two rows", () => {
    const rows = rowsOf({
      recentSenders: [seen("Family", "111@g.us", 1), seen("Family", "5@lid", 0)],
    });
    expect(rows.map((r) => r.kindLabel)).toEqual([
      "Chat · last message just now",
      "Group · last message 1 minute ago",
    ]);
  });

  it("a group recognised by behaviour counts as a group", () => {
    const rows = rowsOf({
      recentSenders: [seen("Team", "7@lid", 1, { group: true }), seen("Team", "8@lid", 5)],
    });
    expect(rows.map((r) => r.kindLabel)).toEqual([
      "Group · last message 1 minute ago",
      "Chat · last message 5 minutes ago",
    ]);
  });

  it("two people with the same name are two rows", () => {
    const rows = rowsOf({
      recentSenders: [seen("Ahmed", "1@lid", 3), seen("Ahmed", "2@lid", 9)],
    });
    expect(rows).toHaveLength(2);
  });

  it("one person under an old and a new kind of id stays ONE row (no repeats)", () => {
    const rows = rowsOf({
      recentSenders: [seen("Radwa", "601@lid", 1), seen("Radwa", "2010@c.us", 900)],
      knownChats: [{ name: "Radwa" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].targets.map((t) => t.chatId).sort()).toEqual(["2010@c.us", "601@lid"]);
    expect(rows[0].kindLabel).toBe("Chat");
  });

  it("a single chat looks exactly as before (no 'last message' text, same key)", () => {
    const rows = rowsOf({ recentSenders: [seen("Mom", "9@lid", 1)] });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("chat|mom");
    expect(rows[0].kindLabel).toBe("Chat");
  });

  it("each row shows its own sound", () => {
    const rows = rowsOf({
      recentSenders: [seen("Family", "111@g.us", 30), seen("Family", "222@g.us", 2)],
      rules: [rule("r1", "111@g.us", "s1"), rule("r2", "222@g.us", "s2")],
    });
    expect(rows.map((r) => r.choice)).toEqual(["s2", "s1"]);
    expect(rows.map((r) => r.hasRule)).toEqual([true, true]);
  });

  it("a sound set earlier for the NAME shows in both rows until one gets its own", () => {
    const rows = rowsOf({
      recentSenders: [seen("Family", "111@g.us", 30), seen("Family", "222@g.us", 2)],
      rules: [rule("rn", null, "s1")],
    });
    expect(rows.map((r) => r.choice)).toEqual(["s1", "s1"]);
  });

  it("search still finds both", () => {
    const rows = buildChatRows(
      {
        recentSenders: [seen("Family", "111@g.us", 30), seen("Family", "222@g.us", 2)],
        knownChats: [],
        rules: [],
        sounds,
      },
      "fam",
      NOW
    );
    expect(rows).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ choosing a sound

describe("a sound picked in one row applies to that chat only", () => {
  let store;

  async function setup(rules = []) {
    let n = 0;
    store = createStateStore({
      storage: createFakeStorage({
        recentSenders: [seen("Family", "111@g.us", 30), seen("Family", "222@g.us", 2)],
        sounds,
        rules,
      }),
      soundStore: createFakeSoundStore(),
      generateId: () => `id${++n}`,
      now: () => NOW,
    });
  }
  const rows = async () => buildChatRows(await store.load(), "", NOW);
  const soundFor = async (chatId) => {
    const state = await store.load();
    return decidePlayback({
      notification: { title: "Family", tag: chatId },
      rules: state.rules,
      sounds,
      settings: { enabled: true, volume: 1, defaultSoundId: null },
    });
  };

  it("gives only that group the sound", async () => {
    await setup();
    const [newer] = await rows();
    await applyChoice(store, newer, "s2");
    expect(await soundFor("222@g.us")).toMatchObject({ action: "play", soundId: "s2" });
    expect(await soundFor("111@g.us")).toEqual({ action: "native" });
  });

  it("two groups, two different sounds", async () => {
    await setup();
    const [newer, older] = await rows();
    await applyChoice(store, newer, "s2");
    await applyChoice(store, older, "s1");
    expect((await soundFor("222@g.us")).soundId).toBe("s2");
    expect((await soundFor("111@g.us")).soundId).toBe("s1");
  });

  it("an older sound set for the NAME is kept by the other group as its own", async () => {
    await setup([rule("rn", null, "s1")]);
    const [newer] = await rows();
    await applyChoice(store, newer, "s2");
    expect((await soundFor("222@g.us")).soundId).toBe("s2");
    expect((await soundFor("111@g.us")).soundId).toBe("s1");
    const state = await store.load();
    expect(state.rules.every((r) => r.chatId)).toBe(true); // no name-only rule left behind
  });

  it("'Default sound' in one row leaves the other group's sound alone", async () => {
    await setup([rule("rn", null, "s1")]);
    const [newer] = await rows();
    await applyChoice(store, newer, CHOICE_DEFAULT);
    expect(await soundFor("222@g.us")).toEqual({ action: "native" });
    expect((await soundFor("111@g.us")).soundId).toBe("s1");
  });

  it("'Silent' in one row silences only that group", async () => {
    await setup();
    const [newer] = await rows();
    await applyChoice(store, newer, "__silent");
    expect((await soundFor("222@g.us")).action).toBe("silent");
    expect((await soundFor("111@g.us")).action).toBe("native");
  });
});
