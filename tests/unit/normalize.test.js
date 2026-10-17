import { describe, it, expect } from "vitest";
import { normalizeName } from "../../src/core/normalize.mjs";

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
