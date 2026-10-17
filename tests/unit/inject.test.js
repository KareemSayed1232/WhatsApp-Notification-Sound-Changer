import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadScript, freshDocument } from "../helpers/load-script.js";

class FakeNotification {
  static instances = [];
  static permission = "granted";
  static requestPermission = vi.fn(() => Promise.resolve("granted"));
  constructor(title, options) {
    this.title = title;
    this.options = options;
    FakeNotification.instances.push(this);
  }
}

let doc;
let win;

function boot() {
  loadScript("scripts/inject.js", { document: doc, window: win, Notification: FakeNotification });
  doc.dispatchEvent(new CustomEvent("WANSC-Initialize"));
}

beforeEach(() => {
  FakeNotification.instances = [];
  doc = freshDocument();
  win = { Notification: FakeNotification };
});

describe("inject.js (page-world Notification hook)", () => {
  it("does nothing until WANSC-Initialize is dispatched", () => {
    loadScript("scripts/inject.js", { document: doc, window: win, Notification: FakeNotification });
    expect(win.Notification).toBe(FakeNotification);
  });

  it("replaces window.Notification on WANSC-Initialize", () => {
    boot();
    expect(win.Notification).not.toBe(FakeNotification);
  });

  it("forces silent=true while preserving the other options", () => {
    boot();
    new win.Notification("Alice", { body: "hi", icon: "x.png", tag: "chat-1" });
    expect(FakeNotification.instances[0].title).toBe("Alice");
    expect(FakeNotification.instances[0].options).toMatchObject({
      body: "hi",
      icon: "x.png",
      tag: "chat-1",
      silent: true,
    });
  });

  it("does not mutate the options object passed in by the page", () => {
    boot();
    const options = { body: "hi" };
    new win.Notification("Alice", options);
    expect(options).toEqual({ body: "hi" });
  });

  it("does not throw when the page omits the options argument", () => {
    boot();
    expect(() => new win.Notification("Alice")).not.toThrow();
    expect(FakeNotification.instances[0].options.silent).toBe(true);
  });

  it("dispatches WANSC-Notification-Triggered on each notification", () => {
    boot();
    const handler = vi.fn();
    doc.addEventListener("WANSC-Notification-Triggered", handler);
    new win.Notification("Alice", {});
    new win.Notification("Bob", {});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("keeps instanceof checks and statics working for the page", async () => {
    boot();
    const n = new win.Notification("Alice", {});
    expect(n instanceof FakeNotification).toBe(true);
    expect(win.Notification.permission).toBe("granted");
    await expect(win.Notification.requestPermission()).resolves.toBe("granted");
  });
});
