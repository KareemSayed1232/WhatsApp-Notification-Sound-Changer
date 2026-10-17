import { describe, it, expect } from "vitest";
import { cleanDisplayName, normalizeName } from "../../src/core/normalize.mjs";

describe("cleanDisplayName", () => {
  it("strips invisible marks and extra whitespace but keeps case", () => {
    expect(cleanDisplayName(" Alice‎  Smith ")).toBe("Alice Smith");
    expect(cleanDisplayName(" \u{1F606}‎")).toBe("\u{1F606}");
  });

  it("returns an empty string for non-strings", () => {
    expect(cleanDisplayName(null)).toBe("");
  });
});

describe("normalizeName", () => {
  it("lowercases, trims and collapses whitespace", () => {
    expect(normalizeName("  Alice   Smith \n")).toBe("alice smith");
  });

  it("folds full-width and compatibility characters (NFKC)", () => {
    expect(normalizeName("ＡＬＩＣＥ")).toBe("alice");
  });

  it("strips bidi marks and zero-width characters around RTL names", () => {
    expect(normalizeName("‏أحمد‎")).toBe("أحمد");
    expect(normalizeName("Al​ice")).toBe("alice");
  });

  it("treats emoji with and without the variation selector as equal", () => {
    expect(normalizeName("❤️ Mom")).toBe(normalizeName("❤ Mom"));
  });

  it("keeps non-Latin and emoji text intact", () => {
    expect(normalizeName("母 🏠")).toBe("母 🏠");
  });

  it("returns an empty string for non-strings", () => {
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
    expect(normalizeName(42)).toBe("");
  });
});
