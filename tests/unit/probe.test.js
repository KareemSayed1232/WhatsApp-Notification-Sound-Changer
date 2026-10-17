import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadScript } from "../helpers/load-script.js";

class FakeNotification {
  static permission = "granted";
  static requestPermission = vi.fn(() => Promise.resolve("granted"));
  static instances = [];
  constructor(title, options) {
    this.title = title;
    this.options = options;
    FakeNotification.instances.push(this);
  }
}

let win;
let consoleFake;

function boot() {
  loadScript("../tools/probe/probe.js", { window: win, console: consoleFake });
}

beforeEach(() => {
  FakeNotification.instances = [];
  win = { Notification: FakeNotification };
  consoleFake = { log: vi.fn() };
});

describe("tools/probe/probe.js", () => {
  it("records title and option shapes and passes the notification through unchanged", () => {
    boot();
    const options = { body: "Alice: hi", tag: "chat-1", data: { chat: "123@c.us" } };
    new win.Notification("Family", options);

    expect(FakeNotification.instances[0].title).toBe("Family");
    expect(FakeNotification.instances[0].options).toBe(options);
    expect(win.__wansc_probe).toHaveLength(1);
    expect(win.__wansc_probe[0]).toMatchObject({
      kind: "notification",
      title: "Family",
      options: {
        body: "Alice: hi",
        tag: "chat-1",
        data: { __type: "object", json: '{"chat":"123@c.us"}' },
      },
    });
  });

  it("does not throw when the page omits the options argument", () => {
    boot();
    expect(() => new win.Notification("Bob")).not.toThrow();
    expect(win.__wansc_probe[0].options).toEqual({});
  });

  it("keeps only the 50 most recent entries", () => {
    boot();
    for (let i = 0; i < 60; i++) new win.Notification(`n${i}`);
    expect(win.__wansc_probe).toHaveLength(50);
    expect(win.__wansc_probe[0].title).toBe("n10");
  });

  it("clips very long strings", () => {
    boot();
    new win.Notification("x", { body: "a".repeat(1000) });
    expect(win.__wansc_probe[0].options.body.length).toBeLessThanOrEqual(301);
  });

  it("reports the live Notification.permission value", () => {
    boot();
    expect(win.Notification.permission).toBe("granted");
    FakeNotification.permission = "denied";
    expect(win.Notification.permission).toBe("denied");
    FakeNotification.permission = "granted";
  });
});
