import { describe, it, expect } from "vitest";
import { parseDataUrl, bytesToDataUrl } from "../../src/core/audio-data.mjs";

describe("parseDataUrl", () => {
  it("decodes a base64 data URL into mime type and bytes", () => {
    const parsed = parseDataUrl("data:audio/mpeg;base64,AQID");
    expect(parsed.mime).toBe("audio/mpeg");
    expect([...parsed.bytes]).toEqual([1, 2, 3]);
  });

  it("tolerates extra parameters such as codecs", () => {
    expect(parseDataUrl("data:audio/ogg;codecs=opus;base64,AQID").mime).toBe("audio/ogg");
  });

  it("returns null for malformed input", () => {
    expect(parseDataUrl("not a data url")).toBeNull();
    expect(parseDataUrl("data:audio/mpeg,plain")).toBeNull();
    expect(parseDataUrl(null)).toBeNull();
    expect(parseDataUrl("data:audio/mpeg;base64,@@@")).toBeNull();
    // Passes the pattern but is not decodable (a lone base64 character).
    expect(parseDataUrl("data:audio/mpeg;base64,A")).toBeNull();
  });
});

describe("bytesToDataUrl", () => {
  it("round-trips through parseDataUrl", () => {
    const bytes = new Uint8Array([0, 255, 128, 7, 9]);
    const parsed = parseDataUrl(bytesToDataUrl("audio/wav", bytes));
    expect(parsed.mime).toBe("audio/wav");
    expect([...parsed.bytes]).toEqual([...bytes]);
  });

  it("handles payloads larger than a single String.fromCharCode chunk", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    const parsed = parseDataUrl(bytesToDataUrl("audio/wav", bytes));
    expect(parsed.bytes.length).toBe(200_000);
    expect(parsed.bytes[199_999]).toBe(199_999 % 251);
  });
});
