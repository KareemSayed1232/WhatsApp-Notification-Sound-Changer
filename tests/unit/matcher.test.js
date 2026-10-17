import { describe, it, expect } from "vitest";
import { parseSenderFromBody, findRule, decidePlayback } from "../../src/core/matcher.mjs";

const rule = (over) => ({
  id: "r1",
  kind: "chat",
  match: "Alice",
  action: "sound",
  soundId: "s1",
  enabled: true,
  ...over,
});

const sounds = {
  s1: { id: "s1", name: "Ping", mime: "audio/mpeg", size: 10 },
  s2: { id: "s2", name: "Chime", mime: "audio/mpeg", size: 10 },
};

describe("parseSenderFromBody", () => {
  it("extracts the sender prefix used in group notifications", () => {
    expect(parseSenderFromBody("Alice: hello")).toBe("Alice");
  });

  it("uses only the first colon", () => {
    expect(parseSenderFromBody("Alice: meet at 10: sharp")).toBe("Alice");
  });

  it("returns null when there is no 'Name: ' prefix", () => {
    expect(parseSenderFromBody("hello there")).toBeNull();
    expect(parseSenderFromBody("https://example.com")).toBeNull();
  });

  it("returns null for implausibly long prefixes (message text, not a name)", () => {
    const text = "Reminder to bring the following items to the meeting tomorrow morning: milk";
    expect(parseSenderFromBody(text)).toBeNull();
  });

  it("returns null for non-strings and empty prefixes", () => {
    expect(parseSenderFromBody(undefined)).toBeNull();
    expect(parseSenderFromBody(": hi")).toBeNull();
  });
});

describe("findRule", () => {
  it("matches a chat rule on the normalized title", () => {
    const rules = [rule({ match: "Alice" })];
    expect(findRule({ title: "  alice " }, rules)).toBe(rules[0]);
  });

  it("matches Arabic and emoji names", () => {
    const rules = [rule({ id: "a", match: "أحمد" }), rule({ id: "b", match: "Mom ❤️" })];
    expect(findRule({ title: "‏أحمد" }, rules).id).toBe("a");
    expect(findRule({ title: "mom ❤" }, rules).id).toBe("b");
  });

  it("ignores disabled rules", () => {
    expect(findRule({ title: "Alice" }, [rule({ enabled: false })])).toBeNull();
  });

  it("matches a sender rule against the group body prefix", () => {
    const rules = [rule({ kind: "sender", match: "Bob" })];
    expect(findRule({ title: "Family", body: "Bob: dinner?" }, rules)).toBe(rules[0]);
  });

  it("does not match a sender rule when the body has no sender prefix", () => {
    const rules = [rule({ kind: "sender", match: "Bob" })];
    expect(findRule({ title: "Bob", body: "dinner?" }, rules)).toBeNull();
  });

  it("prefers a chat rule over a sender rule when both match", () => {
    const rules = [
      rule({ id: "sender", kind: "sender", match: "Bob" }),
      rule({ id: "chat", kind: "chat", match: "Family" }),
    ];
    expect(findRule({ title: "Family", body: "Bob: hi" }, rules).id).toBe("chat");
  });

  it("uses the first matching rule within a kind", () => {
    const rules = [rule({ id: "first" }), rule({ id: "second" })];
    expect(findRule({ title: "Alice" }, rules).id).toBe("first");
  });

  it("returns null when nothing matches or input is malformed", () => {
    expect(findRule({ title: "Zed" }, [rule()])).toBeNull();
    expect(findRule({}, [rule()])).toBeNull();
    expect(findRule({ title: "Alice" }, undefined)).toBeNull();
  });
});

describe("decidePlayback", () => {
  const settings = { enabled: true, volume: 0.5, defaultSoundId: "s2" };

  it("leaves the notification native when the extension is disabled", () => {
    const d = decidePlayback({
      notification: { title: "Alice" },
      rules: [rule()],
      sounds,
      settings: { ...settings, enabled: false },
    });
    expect(d).toEqual({ action: "native" });
  });

  it("plays the sound of a matching rule at the configured volume", () => {
    const d = decidePlayback({
      notification: { title: "Alice" },
      rules: [rule()],
      sounds,
      settings,
    });
    expect(d).toEqual({ action: "play", soundId: "s1", volume: 0.5, ruleId: "r1" });
  });

  it("stays silent for a silent rule", () => {
    const d = decidePlayback({
      notification: { title: "Alice" },
      rules: [rule({ action: "silent", soundId: null })],
      sounds,
      settings,
    });
    expect(d).toEqual({ action: "silent", ruleId: "r1" });
  });

  it("uses the default sound for a rule whose action is default", () => {
    const d = decidePlayback({
      notification: { title: "Alice" },
      rules: [rule({ action: "default", soundId: null })],
      sounds,
      settings,
    });
    expect(d).toMatchObject({ action: "play", soundId: "s2" });
  });

  it("plays the default sound when no rule matches", () => {
    const d = decidePlayback({ notification: { title: "Zed" }, rules: [rule()], sounds, settings });
    expect(d).toEqual({ action: "play", soundId: "s2", volume: 0.5, ruleId: null });
  });

  it("stays native when no rule matches and there is no default sound", () => {
    const d = decidePlayback({
      notification: { title: "Zed" },
      rules: [rule()],
      sounds,
      settings: { ...settings, defaultSoundId: null },
    });
    expect(d).toEqual({ action: "native" });
  });

  it("falls back to the default sound when a rule points at a deleted sound", () => {
    const d = decidePlayback({
      notification: { title: "Alice" },
      rules: [rule({ soundId: "gone" })],
      sounds,
      settings,
    });
    expect(d).toMatchObject({ action: "play", soundId: "s2" });
  });

  it("stays native when both the rule sound and the default sound are missing", () => {
    const d = decidePlayback({
      notification: { title: "Alice" },
      rules: [rule({ soundId: "gone" })],
      sounds,
      settings: { ...settings, defaultSoundId: "also-gone" },
    });
    expect(d).toEqual({ action: "native" });
  });

  it("clamps volume into 0..1 and defaults it to 1", () => {
    const base = { notification: { title: "Alice" }, rules: [rule()], sounds };
    expect(decidePlayback({ ...base, settings: { ...settings, volume: 7 } }).volume).toBe(1);
    expect(decidePlayback({ ...base, settings: { ...settings, volume: -1 } }).volume).toBe(0);
    expect(decidePlayback({ ...base, settings: { ...settings, volume: undefined } }).volume).toBe(
      1
    );
  });
});
