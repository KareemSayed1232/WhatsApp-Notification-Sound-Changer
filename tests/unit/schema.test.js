import { describe, it, expect } from "vitest";
import {
  SCHEMA_VERSION,
  MAX_SOUND_BYTES,
  MAX_MATCH_LENGTH,
  defaultSettings,
  validateRule,
  validateSoundFile,
  clampVolume,
} from "../../src/core/schema.mjs";

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
};

describe("schema constants", () => {
  it("is schema version 2 with sane defaults", () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(defaultSettings()).toEqual({
      enabled: true,
      volume: 1,
      defaultSoundId: null,
      showPopups: false,
    });
  });

  it("returns a fresh defaults object each time", () => {
    expect(defaultSettings()).not.toBe(defaultSettings());
  });
});

describe("validateRule", () => {
  const good = { kind: "chat", match: "Alice", action: "sound", soundId: "s1" };

  it("accepts a valid rule", () => {
    expect(() => validateRule(good)).not.toThrow();
    expect(() => validateRule({ kind: "sender", match: "Bob", action: "silent" })).not.toThrow();
    expect(() => validateRule({ kind: "chat", match: "Bob", action: "default" })).not.toThrow();
  });

  it("rejects an empty or whitespace-only match", () => {
    expect(codeOf(() => validateRule({ ...good, match: "   " }))).toBe("empty-match");
    expect(codeOf(() => validateRule({ ...good, match: "‎" }))).toBe("empty-match");
  });

  it("rejects an over-long match", () => {
    expect(codeOf(() => validateRule({ ...good, match: "a".repeat(MAX_MATCH_LENGTH + 1) }))).toBe(
      "match-too-long"
    );
  });

  it("rejects unknown kinds and actions", () => {
    expect(codeOf(() => validateRule({ ...good, kind: "regex" }))).toBe("invalid-kind");
    expect(codeOf(() => validateRule({ ...good, action: "explode" }))).toBe("invalid-action");
  });

  it("accepts an optional string chatId and rejects other types", () => {
    expect(() => validateRule({ ...good, chatId: "123@lid" })).not.toThrow();
    expect(() => validateRule({ ...good, chatId: null })).not.toThrow();
    expect(codeOf(() => validateRule({ ...good, chatId: 42 }))).toBe("invalid-chat-id");
    expect(codeOf(() => validateRule({ ...good, chatId: "x".repeat(201) }))).toBe(
      "invalid-chat-id"
    );
  });

  it("requires a soundId when the action is sound", () => {
    expect(codeOf(() => validateRule({ ...good, soundId: null }))).toBe("missing-sound");
  });
});

describe("validateSoundFile", () => {
  it("accepts common audio types under the size limit", () => {
    for (const type of ["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4"]) {
      expect(() => validateSoundFile({ type, size: 1000 })).not.toThrow();
    }
  });

  it("rejects non-audio types", () => {
    expect(codeOf(() => validateSoundFile({ type: "text/html", size: 10 }))).toBe(
      "unsupported-type"
    );
    expect(codeOf(() => validateSoundFile({ type: "", size: 10 }))).toBe("unsupported-type");
  });

  it("rejects empty and oversize files", () => {
    expect(codeOf(() => validateSoundFile({ type: "audio/mpeg", size: 0 }))).toBe("empty-file");
    expect(codeOf(() => validateSoundFile({ type: "audio/mpeg", size: MAX_SOUND_BYTES + 1 }))).toBe(
      "file-too-large"
    );
  });
});

describe("clampVolume", () => {
  it("clamps to 0..1 and falls back to 1 for non-numbers", () => {
    expect(clampVolume(0.4)).toBe(0.4);
    expect(clampVolume(5)).toBe(1);
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume("loud")).toBe(1);
    expect(clampVolume(NaN)).toBe(1);
  });
});
