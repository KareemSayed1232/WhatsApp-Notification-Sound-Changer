import { describe, it, expect } from "vitest";
import {
  CHOICE_DEFAULT,
  CHOICE_SILENT,
  CHOICE_UPLOAD,
  buildChatRows,
  buildSoundRows,
  choiceToAction,
  defaultSoundHint,
  formatBytes,
  kindLabel,
  ruleFor,
  ruleToChoice,
  soundChoices,
} from "../../src/ui/view-model.mjs";

const sounds = {
  b: { id: "b", name: "Chime", size: 2048, createdAt: 2 },
  a: { id: "a", name: "Ping", size: 3 * 1024 * 1024, createdAt: 1 },
};

const state = (over = {}) => ({
  settings: { enabled: true, volume: 1, defaultSoundId: "a", showPopups: false },
  sounds,
  rules: [],
  recentSenders: [],
  ...over,
});

describe("formatBytes", () => {
  it("formats KB and MB and never shows 0 KB for a real file", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(10)).toBe("1 KB");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(undefined)).toBe("0 KB");
  });
});

describe("kindLabel", () => {
  it("tells groups, chats and senders apart", () => {
    expect(kindLabel("chat", "120@g.us")).toBe("Group");
    expect(kindLabel("chat", "601@lid")).toBe("Chat");
    expect(kindLabel("chat", null)).toBe("Chat");
    expect(kindLabel("sender", null)).toBe("Person in a group");
  });
});

describe("choices", () => {
  it("maps a rule to the dropdown value and back", () => {
    expect(ruleToChoice({ action: "silent" }, sounds)).toBe(CHOICE_SILENT);
    expect(ruleToChoice({ action: "default" }, sounds)).toBe(CHOICE_DEFAULT);
    expect(ruleToChoice({ action: "sound", soundId: "b" }, sounds)).toBe("b");
    expect(ruleToChoice({ action: "sound", soundId: "gone" }, sounds)).toBe(CHOICE_DEFAULT);

    expect(choiceToAction(CHOICE_SILENT)).toEqual({ action: "silent", soundId: null });
    expect(choiceToAction(CHOICE_DEFAULT)).toEqual({ action: "default", soundId: null });
    expect(choiceToAction("")).toEqual({ action: "default", soundId: null });
    expect(choiceToAction("b")).toEqual({ action: "sound", soundId: "b" });
  });

  it("lists default, silent, then sounds oldest first", () => {
    expect(soundChoices(sounds).map((c) => c.value)).toEqual([
      CHOICE_DEFAULT,
      CHOICE_SILENT,
      "a",
      "b",
    ]);
  });

  it("adds an 'upload new sound' option last, only when asked", () => {
    const withUpload = soundChoices(sounds, { allowUpload: true });
    expect(withUpload.at(-1)).toEqual({ value: CHOICE_UPLOAD, label: "＋ Upload new sound…" });
    expect(soundChoices(sounds).map((c) => c.value)).not.toContain(CHOICE_UPLOAD);
  });
});

describe("defaultSoundHint", () => {
  it("explains what 'no default' means, so it is never a mystery", () => {
    expect(defaultSoundHint(state({ settings: { defaultSoundId: null } }))).toMatch(
      /WhatsApp's normal sound/
    );
    expect(defaultSoundHint(state({ settings: { defaultSoundId: "gone" } }))).toMatch(
      /WhatsApp's normal sound/
    );
  });

  it("says who uses the default when one is set", () => {
    expect(defaultSoundHint(state({ settings: { defaultSoundId: "a" } }))).toMatch(
      /no sound of its own/
    );
  });
});

describe("buildSoundRows", () => {
  it("marks the default and counts the rules using each sound", () => {
    const rows = buildSoundRows(
      state({
        rules: [
          { id: "1", action: "sound", soundId: "b" },
          { id: "2", action: "sound", soundId: "b" },
          { id: "3", action: "silent", soundId: null },
        ],
      })
    );
    expect(rows).toEqual([
      { id: "a", name: "Ping", sizeLabel: "3.0 MB", isDefault: true, usedBy: 0 },
      { id: "b", name: "Chime", sizeLabel: "2 KB", isDefault: false, usedBy: 2 },
    ]);
  });
});

describe("ruleFor", () => {
  const rules = [
    { id: "id", kind: "chat", match: "Old name", chatId: "601@lid" },
    { id: "name", kind: "chat", match: "Alice" },
    { id: "who", kind: "sender", match: "Bob" },
  ];

  it("finds a chat's rule by chat id, even after a rename", () => {
    expect(ruleFor({ kind: "chat", name: "New name", chatId: "601@lid" }, rules).id).toBe("id");
  });

  it("does not match an id-bound rule for a different chat with the same name", () => {
    const bound = [{ id: "x", kind: "chat", match: "Alice", chatId: "601@lid" }];
    expect(ruleFor({ kind: "chat", name: "Alice", chatId: "999@lid" }, bound)).toBeNull();
  });

  it("finds a name-only rule whatever the chat id, ignoring case", () => {
    expect(ruleFor({ kind: "chat", name: "ALICE", chatId: "7@lid" }, rules).id).toBe("name");
  });

  it("matches sender rules by name and keeps kinds apart", () => {
    expect(ruleFor({ kind: "sender", name: "bob" }, rules).id).toBe("who");
    expect(ruleFor({ kind: "chat", name: "Bob" }, rules)).toBeNull();
  });
});

describe("buildChatRows", () => {
  const recentSenders = [
    { name: "Radwa", kind: "chat", chatId: "601@lid", lastSeen: 3 },
    { name: "Family", kind: "chat", chatId: "120@g.us", lastSeen: 2 },
    { name: "Bob", kind: "sender", lastSeen: 1 },
  ];

  it("lists every chat we have seen, newest first, with the default choice when it has no rule", () => {
    const rows = buildChatRows(state({ recentSenders }));
    expect(rows.map((r) => r.name)).toEqual(["Radwa", "Family", "Bob"]);
    expect(rows[0]).toMatchObject({
      key: "chat|601@lid",
      chatId: "601@lid",
      hasRule: false,
      ruleId: null,
      choice: CHOICE_DEFAULT,
      kindLabel: "Chat",
    });
    expect(rows[1].kindLabel).toBe("Group");
    expect(rows[2]).toMatchObject({ key: "sender|bob", kind: "sender", chatId: null });
  });

  it("shows the sound a chat already has", () => {
    const rules = [
      { id: "r1", kind: "chat", match: "Radwa", chatId: "601@lid", action: "sound", soundId: "b" },
      { id: "r2", kind: "chat", match: "Family", chatId: "120@g.us", action: "silent" },
    ];
    const rows = buildChatRows(state({ recentSenders, rules }));
    expect(rows[0]).toMatchObject({ hasRule: true, ruleId: "r1", choice: "b" });
    expect(rows[1]).toMatchObject({ hasRule: true, ruleId: "r2", choice: CHOICE_SILENT });
    expect(rows[2].hasRule).toBe(false);
  });

  it("uses the chat's latest seen name when it was renamed", () => {
    const rules = [
      { id: "r1", kind: "chat", match: "Old name", chatId: "601@lid", action: "silent" },
    ];
    const rows = buildChatRows(state({ recentSenders: [recentSenders[0]], rules }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Radwa", ruleId: "r1" });
  });

  it("appends rules for chats not seen yet, alphabetically, without duplicating covered ones", () => {
    const rules = [
      { id: "r1", kind: "chat", match: "Radwa", chatId: "601@lid", action: "silent" },
      { id: "r2", kind: "chat", match: "Zed", action: "silent" },
      { id: "r3", kind: "chat", match: "Amy", action: "silent" },
    ];
    const rows = buildChatRows(state({ recentSenders, rules }));
    expect(rows.map((r) => r.name)).toEqual(["Radwa", "Family", "Bob", "Amy", "Zed"]);
    expect(rows.find((r) => r.name === "Amy")).toMatchObject({ hasRule: true, lastSeen: 0 });
  });

  it("filters by name, ignoring case and invisible marks", () => {
    expect(buildChatRows(state({ recentSenders }), "  FAM‎").map((r) => r.name)).toEqual([
      "Family",
    ]);
    expect(buildChatRows(state({ recentSenders }), "zzz")).toEqual([]);
  });

  it("is empty when nothing has been seen and there are no rules", () => {
    expect(buildChatRows(state())).toEqual([]);
  });
});
