import { describe, it, expect } from "vitest";
import { healthStatus } from "../../src/core/health.mjs";
import { healthMessage } from "../../src/ui/health-ui.mjs";

// Owner's case: WhatsApp's own notifications were switched off. WhatsApp still played its sound,
// but without a notification it never says which chat a message is from, so the chats' own sounds
// could not play. The status line has to say that plainly, and how to fix it.

describe("when WhatsApp plays sounds but sends no notifications", () => {
  const health = { unnamedRun: 4, lastPairedAt: 5 };

  it("is its own status", () => {
    expect(healthStatus(health).code).toBe("no-chat-info");
  });

  it("says what is happening, in plain words", () => {
    const { text } = healthMessage(health, 10);
    expect(text).toMatch(/not sending notifications/i);
    expect(text).toMatch(/default sound/i);
  });

  it("says exactly how to fix it", () => {
    const { text } = healthMessage(health, 10);
    expect(text).toMatch(/Settings → Notifications/);
    expect(text).toMatch(/reload the WhatsApp tab/i);
  });
});
