import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { icon } from "../../src/ui/icons.mjs";

// Provided by the jsdom test environment (see vitest.config.js).
const { document } = globalThis;

const NAMES = [
  "play",
  "stop",
  "trash",
  "upload",
  "plus",
  "check",
  "star",
  "refresh",
  "bell",
  "speaker",
  "link",
  "settings",
];

describe("icon", () => {
  it.each(NAMES)("builds a real SVG for %s", (name) => {
    const span = icon(document, name, 20);
    expect(span.className).toBe("icon");
    expect(span.getAttribute("aria-hidden")).toBe("true");
    const svg = span.firstElementChild;
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.childElementCount).toBeGreaterThan(0);
    for (const shape of svg.children) {
      expect(shape.namespaceURI).toBe("http://www.w3.org/2000/svg");
    }
  });

  it("renders an empty SVG, not an error, for an unknown name", () => {
    const svg = icon(document, "nope").firstElementChild;
    expect(svg.childElementCount).toBe(0);
  });

  it("never uses innerHTML (Firefox's add-on review and linter reject it)", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/ui/icons.mjs"), "utf8");
    expect(source).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/);
  });
});
