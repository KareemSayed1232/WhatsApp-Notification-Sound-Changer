import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { startChatWatcher } from "../../src/content/chat-watcher.mjs";
import { installMainHook } from "../../src/content/main-hook.mjs";
import { EVENT_ANSWER, EVENT_ASK } from "../../src/core/protocol.mjs";

// The owner saw high CPU use. WhatsApp's page changes many times a second (typing indicators,
// "online", times), so anything done per change must be cheap and rare. These tests COUNT work
// (reads, page scans, round trips) instead of timing it, so they are stable.

class FakeObserver {
  static all = [];
  constructor(callback) {
    this.callback = callback;
    FakeObserver.all.push(this);
  }
  observe() {}
  disconnect() {
    this.callback = () => {};
  }
}
const mutate = (times = 1) => {
  for (let i = 0; i < times; i++) FakeObserver.all.forEach((o) => o.callback());
};

beforeEach(() => {
  FakeObserver.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

// ------------------------------------------------------------------ while WhatsApp is loading

describe("looking for the chat list while WhatsApp loads", () => {
  it("the name collector looks at most about once a second, not on every page change", () => {
    const findPane = vi.fn(() => null);
    startChatWatcher({
      chrome: {
        runtime: {
          id: "ext",
          sendMessage: vi.fn(),
          onMessage: { addListener: () => {}, removeListener: () => {} },
        },
      },
      document: freshDocument(),
      MutationObserverCtor: FakeObserver,
      readNames: () => [],
      findPane,
    });
    findPane.mockClear();
    for (let i = 0; i < 20; i++) {
      mutate(50); // a busy page: 50 changes every 100 ms
      vi.advanceTimersByTime(100);
    }
    expect(findPane.mock.calls.length).toBeLessThanOrEqual(3); // 2 s of loading
  });
});

// ------------------------------------------------------------------ while WhatsApp is open

describe("the page reader avoids repeated work", () => {
  const page = () =>
    freshDocument(
      '<!DOCTYPE html><html><body><div id="pane-side">' +
        '<div role="row"><span dir="auto" title="Radwa">Radwa</span></div>' +
        '<div role="row"><span dir="auto" title="Mom">Mom</span></div>' +
        "</div></body></html>"
    );

  it("the name collector reads the list at most about once every 1.5 s while it keeps changing", () => {
    const readNames = vi.fn(() => []);
    startChatWatcher({
      chrome: {
        runtime: {
          id: "ext",
          sendMessage: vi.fn(),
          onMessage: { addListener: () => {}, removeListener: () => {} },
        },
      },
      document: page(),
      MutationObserverCtor: FakeObserver,
      readNames,
      findPane: () => ({}),
    });
    readNames.mockClear();
    for (let i = 0; i < 30; i++) {
      mutate(20);
      vi.advanceTimersByTime(100); // 3 s of constant changes
    }
    expect(readNames.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// ------------------------------------------------------------------ the bridge and the hook

describe("cheap answers to frequent questions", () => {
  it("WhatsApp checking its notification permission over and over costs one question a second", () => {
    let t = 1_000;
    const doc = freshDocument();
    const asked = vi.fn(() =>
      doc.dispatchEvent(new CustomEvent(EVENT_ANSWER, { detail: '{"spoof":true}' }))
    );
    doc.addEventListener(EVENT_ASK, asked);
    const win = {
      Notification: class {
        static permission = "denied";
      },
      HTMLMediaElement: class {},
      CustomEvent,
    };
    const hook = installMainHook({ window: win, document: doc, now: () => t });
    for (let i = 0; i < 100; i++) expect(win.Notification.permission).toBe("granted");
    expect(asked).toHaveBeenCalledTimes(1);
    t += 1_100;
    expect(win.Notification.permission).toBe("granted");
    expect(asked).toHaveBeenCalledTimes(2); // a changed setting still takes effect quickly
    hook.uninstall();
  });
});
