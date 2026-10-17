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
  loadScript("../tools/probe/probe.js", {
    window: win,
    console: consoleFake,
    document: { visibilityState: "hidden", hasFocus: () => false },
  });
}

beforeEach(() => {
  FakeNotification.instances = [];
  win = { Notification: FakeNotification };
  consoleFake = { log: vi.fn() };
});

describe("tools/probe/probe.js", () => {
  it("records title and option shapes without creating a real notification (no popup)", () => {
    boot();
    const options = { body: "Alice: hi", tag: "chat-1", data: { chat: "123@c.us" } };
    const stub = new win.Notification("Family", options);

    expect(FakeNotification.instances).toHaveLength(0);
    expect(stub).toMatchObject({ title: "Family", body: "Alice: hi", tag: "chat-1" });
    expect(win.__wansc_probe).toHaveLength(1);
    expect(win.__wansc_probe[0]).toMatchObject({
      kind: "notification",
      title: "Family",
      options: {
        body: { length: 9, senderPrefix: "Alice" },
        tag: "chat-1",
        data: { __type: "object", json: '{"chat":"123@c.us"}' },
      },
    });
  });

  it("records page visibility, focus and permission with every entry", () => {
    boot();
    new win.Notification("Alice");
    expect(win.__wansc_probe[0].page).toEqual({
      visible: "hidden",
      focused: false,
      permission: "granted",
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
    new win.Notification("x", { tag: "a".repeat(1000) });
    expect(win.__wansc_probe[0].options.tag.length).toBeLessThanOrEqual(301);
  });

  it("never logs message text, only its length and any 'Sender: ' prefix", () => {
    boot();
    new win.Notification("Family", { body: "Bob: secret plan" });
    new win.Notification("Alice", { body: "just some text" });
    const logged = JSON.stringify(win.__wansc_probe);
    expect(logged).not.toContain("secret plan");
    expect(logged).not.toContain("just some text");
    expect(win.__wansc_probe[0].options.body).toEqual({ length: 16, senderPrefix: "Bob" });
    expect(win.__wansc_probe[1].options.body).toEqual({ length: 14, senderPrefix: null });
  });

  it("logs each entry as one flat JSON string", () => {
    boot();
    new win.Notification("Alice", { tag: "t1" });
    const line = consoleFake.log.mock.calls.at(-1)[0];
    expect(line.startsWith("[WANSC-PROBE] ")).toBe(true);
    expect(JSON.parse(line.slice("[WANSC-PROBE] ".length)).title).toBe("Alice");
  });

  it("tells the page permission is granted even when the browser has it blocked", () => {
    FakeNotification.permission = "denied";
    boot();
    expect(win.Notification.permission).toBe("granted");
    new win.Notification("Alice");
    expect(win.__wansc_probe[0].page.permission).toBe("denied"); // the real value is still logged
    FakeNotification.permission = "granted";
  });

  it("answers requestPermission with granted without prompting the browser", async () => {
    boot();
    await expect(win.Notification.requestPermission()).resolves.toBe("granted");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("returns an inert stub that tolerates the calls pages make on notifications", () => {
    boot();
    const stub = new win.Notification("Alice", { body: "hi" });
    expect(() => {
      stub.onclick = () => {};
      stub.addEventListener("click", () => {});
      stub.removeEventListener("click", () => {});
      stub.close();
    }).not.toThrow();
    expect(stub.dispatchEvent({})).toBe(true);
  });
});
