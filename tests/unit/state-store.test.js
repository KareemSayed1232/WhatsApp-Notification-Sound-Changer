import { describe, it, expect, beforeEach } from "vitest";
import { createStateStore } from "../../src/core/state-store.mjs";
import { createFakeStorage, createFakeSoundStore } from "../helpers/fake-storage.js";

let storage;
let soundStore;
let store;
let counter;

const fakeFile = (over = {}) => ({
  name: "ping.mp3",
  type: "audio/mpeg",
  size: 3,
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  ...over,
});

function makeStore(initial = {}) {
  storage = createFakeStorage(initial);
  soundStore = createFakeSoundStore();
  counter = 0;
  store = createStateStore({
    storage,
    soundStore,
    generateId: () => `id${++counter}`,
    now: () => 1_700_000_000_000,
  });
}

const codeOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return null;
};

beforeEach(() => makeStore());

describe("load / defaults", () => {
  it("returns default state on first run and records the schema version", async () => {
    const state = await store.load();
    expect(state).toEqual({
      schemaVersion: 2,
      settings: { enabled: true, volume: 1, defaultSoundId: null },
      sounds: {},
      rules: [],
      recentSenders: [],
    });
    expect(storage.data.schemaVersion).toBe(2);
  });

  it("repairs corrupt stored values instead of throwing", async () => {
    makeStore({ schemaVersion: 2, rules: "garbage", settings: null, sounds: 5 });
    const state = await store.load();
    expect(state.rules).toEqual([]);
    expect(state.settings).toEqual({ enabled: true, volume: 1, defaultSoundId: null });
    expect(state.sounds).toEqual({});
  });
});

describe("migration from v1 (single uploadedAudio data URL)", () => {
  const legacy = "data:audio/mpeg;base64,AQID";

  it("moves the legacy sound into the sound store and makes it the default", async () => {
    makeStore({ uploadedAudio: legacy });
    const state = await store.load();

    expect(Object.keys(state.sounds)).toEqual(["legacy-default"]);
    expect(state.sounds["legacy-default"]).toMatchObject({ mime: "audio/mpeg", size: 3 });
    expect(state.settings.defaultSoundId).toBe("legacy-default");

    const blob = await soundStore.get("legacy-default");
    expect(blob.mime).toBe("audio/mpeg");
    expect([...new Uint8Array(blob.data)]).toEqual([1, 2, 3]);
    expect("uploadedAudio" in storage.data).toBe(false);
  });

  it("is idempotent", async () => {
    makeStore({ uploadedAudio: legacy });
    const first = await store.load();
    const second = await store.load();
    expect(second).toEqual(first);
    expect(await soundStore.ids()).toEqual(["legacy-default"]);
  });

  it("does not delete the legacy sound if saving it fails", async () => {
    makeStore({ uploadedAudio: legacy });
    soundStore.failNextPut = true;
    await expect(store.load()).rejects.toThrow("disk full");
    expect(storage.data.uploadedAudio).toBe(legacy);
  });

  it("finishes cleanup if a previous run crashed before removing the legacy key", async () => {
    makeStore({
      uploadedAudio: legacy,
      sounds: { "legacy-default": { id: "legacy-default", name: "Custom sound" } },
      settings: { enabled: true, volume: 1, defaultSoundId: "legacy-default" },
    });
    const state = await store.load();
    expect("uploadedAudio" in storage.data).toBe(false);
    expect(state.settings.defaultSoundId).toBe("legacy-default");
    expect(await soundStore.ids()).toEqual([]);
  });

  it("keeps working when the legacy value is unreadable", async () => {
    makeStore({ uploadedAudio: "garbage" });
    const state = await store.load();
    expect(state.sounds).toEqual({});
    expect(state.settings.defaultSoundId).toBeNull();
    expect(storage.data.uploadedAudio).toBe("garbage");
  });
});

describe("rules", () => {
  it("adds a rule with a generated id and persists it", async () => {
    const rule = await store.addRule({ kind: "chat", match: " Alice ", action: "silent" });
    expect(rule).toMatchObject({
      id: "id1",
      kind: "chat",
      match: "Alice",
      action: "silent",
      soundId: null,
      enabled: true,
    });
    expect((await store.load()).rules).toEqual([rule]);
  });

  it("rejects invalid rules without writing anything", async () => {
    await store.load();
    const sets = storage.calls.set;
    expect(await codeOf(store.addRule({ kind: "chat", match: "", action: "silent" }))).toBe(
      "empty-match"
    );
    expect(storage.calls.set).toBe(sets);
  });

  it("rejects a sound rule that references an unknown sound", async () => {
    expect(
      await codeOf(store.addRule({ kind: "chat", match: "A", action: "sound", soundId: "nope" }))
    ).toBe("unknown-sound");
  });

  it("rejects duplicates after normalization", async () => {
    await store.addRule({ kind: "chat", match: "Alice", action: "silent" });
    expect(await codeOf(store.addRule({ kind: "chat", match: " ALICE ", action: "silent" }))).toBe(
      "duplicate-rule"
    );
    await expect(
      store.addRule({ kind: "sender", match: "Alice", action: "silent" })
    ).resolves.toBeTruthy();
  });

  it("updates a rule and re-validates it", async () => {
    const rule = await store.addRule({ kind: "chat", match: "Alice", action: "silent" });
    const updated = await store.updateRule(rule.id, { enabled: false, match: "Alicia" });
    expect(updated).toMatchObject({ id: rule.id, enabled: false, match: "Alicia" });
    expect(await codeOf(store.updateRule(rule.id, { match: "" }))).toBe("empty-match");
    expect((await store.load()).rules[0].match).toBe("Alicia");
  });

  it("does not flag a rule as a duplicate of itself", async () => {
    const rule = await store.addRule({ kind: "chat", match: "Alice", action: "silent" });
    await expect(store.updateRule(rule.id, { match: "alice" })).resolves.toBeTruthy();
  });

  it("deletes a rule and errors on unknown ids", async () => {
    const rule = await store.addRule({ kind: "chat", match: "Alice", action: "silent" });
    await store.deleteRule(rule.id);
    expect((await store.load()).rules).toEqual([]);
    expect(await codeOf(store.deleteRule("missing"))).toBe("not-found");
    expect(await codeOf(store.updateRule("missing", {}))).toBe("not-found");
  });

  it("serializes concurrent writes so none are lost", async () => {
    await Promise.all([
      store.addRule({ kind: "chat", match: "A", action: "silent" }),
      store.addRule({ kind: "chat", match: "B", action: "silent" }),
      store.addRule({ kind: "chat", match: "C", action: "silent" }),
    ]);
    const rules = (await store.load()).rules;
    expect(rules.map((r) => r.match).sort()).toEqual(["A", "B", "C"]);
    expect(new Set(rules.map((r) => r.id)).size).toBe(3);
  });
});

describe("sounds", () => {
  it("stores the bytes and metadata for an uploaded file", async () => {
    const meta = await store.addSound(fakeFile());
    expect(meta).toEqual({
      id: "id1",
      name: "ping.mp3",
      mime: "audio/mpeg",
      size: 3,
      createdAt: 1_700_000_000_000,
    });
    expect((await store.load()).sounds.id1).toEqual(meta);
    expect([...new Uint8Array((await soundStore.get("id1")).data)]).toEqual([1, 2, 3]);
  });

  it("rejects invalid files before touching storage", async () => {
    expect(await codeOf(store.addSound(fakeFile({ type: "text/plain" })))).toBe("unsupported-type");
    expect(await soundStore.ids()).toEqual([]);
  });

  it("does not record metadata when saving the bytes fails", async () => {
    soundStore.failNextPut = true;
    await expect(store.addSound(fakeFile())).rejects.toThrow("disk full");
    expect((await store.load()).sounds).toEqual({});
  });

  it("deleting a sound resets rules and the default that used it", async () => {
    const sound = await store.addSound(fakeFile());
    const other = await store.addSound(fakeFile({ name: "other.mp3" }));
    const used = await store.addRule({
      kind: "chat",
      match: "Alice",
      action: "sound",
      soundId: sound.id,
    });
    const kept = await store.addRule({
      kind: "chat",
      match: "Bob",
      action: "sound",
      soundId: other.id,
    });
    await store.setSettings({ defaultSoundId: sound.id });

    const result = await store.deleteSound(sound.id);

    expect(result.affectedRuleIds).toEqual([used.id]);
    const state = await store.load();
    expect(state.sounds[sound.id]).toBeUndefined();
    expect(state.rules.find((r) => r.id === used.id)).toMatchObject({
      action: "default",
      soundId: null,
    });
    expect(state.rules.find((r) => r.id === kept.id).soundId).toBe(other.id);
    expect(state.settings.defaultSoundId).toBeNull();
    expect(await soundStore.get(sound.id)).toBeNull();
  });

  it("errors when deleting an unknown sound", async () => {
    expect(await codeOf(store.deleteSound("nope"))).toBe("not-found");
  });
});

describe("settings", () => {
  it("merges and sanitizes settings", async () => {
    const settings = await store.setSettings({ volume: 9, enabled: false });
    expect(settings).toEqual({ enabled: false, volume: 1, defaultSoundId: null });
  });

  it("rejects a default sound that does not exist", async () => {
    expect(await codeOf(store.setSettings({ defaultSoundId: "nope" }))).toBe("unknown-sound");
  });
});

describe("recent senders", () => {
  it("records newest first and de-duplicates by normalized name", async () => {
    await store.recordSender({ name: "Alice", kind: "chat" });
    await store.recordSender({ name: "Bob", kind: "chat" });
    await store.recordSender({ name: " ALICE ", kind: "chat" });
    const names = (await store.load()).recentSenders.map((s) => s.name);
    expect(names).toEqual([" ALICE ".trim(), "Bob"]);
  });

  it("keeps the same name separate for different kinds", async () => {
    await store.recordSender({ name: "Alice", kind: "chat" });
    await store.recordSender({ name: "Alice", kind: "sender" });
    expect((await store.load()).recentSenders).toHaveLength(2);
  });

  it("caps the list at 50 entries", async () => {
    for (let i = 0; i < 60; i++) await store.recordSender({ name: `n${i}`, kind: "chat" });
    const list = (await store.load()).recentSenders;
    expect(list).toHaveLength(50);
    expect(list[0].name).toBe("n59");
  });

  it("ignores empty names and stores no message text", async () => {
    await store.recordSender({ name: "  ", kind: "chat" });
    await store.recordSender({ name: "Alice", kind: "chat", body: "secret" });
    const list = (await store.load()).recentSenders;
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ name: "Alice", kind: "chat", lastSeen: 1_700_000_000_000 });
  });
});
