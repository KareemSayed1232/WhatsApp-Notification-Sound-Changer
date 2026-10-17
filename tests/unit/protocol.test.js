import { describe, it, expect } from "vitest";
import { isKnownIncomingSound, isWhatsAppSound } from "../../src/core/protocol.mjs";

const incoming = "https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3";

describe("isWhatsAppSound", () => {
  it("accepts an mp3 on WhatsApp's static host", () => {
    expect(isWhatsAppSound(incoming)).toBe(true);
    expect(isWhatsAppSound("https://static.whatsapp.net/rsrc.php/x/other.mp3")).toBe(true);
  });

  it("rejects other hosts, non-mp3 files and garbage", () => {
    expect(isWhatsAppSound("https://example.com/BS_BUUXbKq5.mp3")).toBe(false);
    expect(isWhatsAppSound("https://static.whatsapp.net.evil.com/a.mp3")).toBe(false);
    expect(isWhatsAppSound("https://static.whatsapp.net/rsrc.php/x/a.png")).toBe(false);
    expect(isWhatsAppSound("blob:https://web.whatsapp.com/1234")).toBe(false);
    expect(isWhatsAppSound("")).toBe(false);
    expect(isWhatsAppSound(undefined)).toBe(false);
  });
});

describe("isKnownIncomingSound", () => {
  it("accepts only the measured incoming-message sound", () => {
    expect(isKnownIncomingSound(incoming)).toBe(true);
    expect(isKnownIncomingSound("https://static.whatsapp.net/rsrc.php/x/other.mp3")).toBe(false);
    expect(isKnownIncomingSound("https://example.com/BS_BUUXbKq5.mp3")).toBe(false);
  });
});
