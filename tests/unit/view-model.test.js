import { describe, it, expect } from "vitest";
import {
  CHOICE_DEFAULT,
  CHOICE_SILENT,
  buildRuleRows,
  buildSoundRows,
  choiceToAction,
  formatBytes,
  kindLabel,
  recentChoices,
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

describe("buildRuleRows", () => {
  const rules = [
    { id: "1", kind: "chat", match: "Zed", chatId: "1@lid", action: "silent", enabled: true },
    {
      id: "2",
      kind: "chat",
      match: "Alice",
      chatId: null,
      action: "sound",
      soundId: "b",
      enabled: false,
    },
    { id: "3", kind: "sender", match: "Bob", action: "default", enabled: true },
  ];

  it("sorts by name and describes each rule", () => {
    const rows = buildRuleRows(state({ rules }));
    expect(rows.map((r) => r.label)).toEqual(["Alice", "Bob", "Zed"]);
    expect(rows[0]).toMatchObject({
      choice: "b",
      enabled: false,
      linked: false,
      kindLabel: "Chat",
    });
    expect(rows[1]).toMatchObject({ kindLabel: "Person in a group", choice: CHOICE_DEFAULT });
    expect(rows[2]).toMatchObject({ linked: true, choice: CHOICE_SILENT });
  });

  it("filters by name, ignoring case and invisible marks", () => {
    expect(buildRuleRows(state({ rules }), "  AL‎").map((r) => r.label)).toEqual(["Alice"]);
    expect(buildRuleRows(state({ rules }), "nothing")).toEqual([]);
  });
});

describe("recentChoices", () => {
  const recentSenders = [
    { name: "Radwa", kind: "chat", chatId: "601@lid", lastSeen: 3 },
    { name: "Family", kind: "chat", chatId: "120@g.us", lastSeen: 2 },
    { name: "Bob", kind: "sender", lastSeen: 1 },
  ];

  it("offers everything when there are no rules, with a stable key", () => {
    const choices = recentChoices(state({ recentSenders }));
    expect(choices.map((c) => c.key)).toEqual(["chat|601@lid", "chat|120@g.us", "sender|bob"]);
    expect(choices[1]).toMatchObject({ kindLabel: "Group", chatId: "120@g.us" });
    expect(choices[2].chatId).toBeNull();
  });

  it("hides chats that already have a rule, by id", () => {
    const rules = [{ id: "1", kind: "chat", match: "Old name", chatId: "601@lid" }];
    expect(recentChoices(state({ recentSenders, rules })).map((c) => c.name)).toEqual([
      "Family",
      "Bob",
    ]);
  });

  it("hides chats covered by a name-only rule, but not an id-bound rule for a different chat", () => {
    const nameRule = [{ id: "1", kind: "chat", match: "radwa" }];
    expect(
      recentChoices(state({ recentSenders, rules: nameRule })).map((c) => c.name)
    ).not.toContain("Radwa");

    const otherChat = [{ id: "1", kind: "chat", match: "Radwa", chatId: "999@lid" }];
    expect(recentChoices(state({ recentSenders, rules: otherChat })).map((c) => c.name)).toContain(
      "Radwa"
    );
  });

  it("hides a person who already has a sender rule", () => {
    const rules = [{ id: "1", kind: "sender", match: "BOB" }];
    expect(recentChoices(state({ recentSenders, rules })).map((c) => c.name)).not.toContain("Bob");
  });

  it("respects the limit", () => {
    expect(recentChoices(state({ recentSenders }), 1)).toHaveLength(1);
  });
});
