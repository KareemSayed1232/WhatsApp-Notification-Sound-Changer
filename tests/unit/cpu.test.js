import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { startBridge } from "../../src/content/bridge.mjs";
import { startChatWatcher } from "../../src/content/chat-watcher.mjs";
import { installMainHook } from "../../src/content/main-hook.mjs";
import { createPageModel } from "../../src/content/page-model.mjs";
import { startUnreadWatcher } from "../../src/content/unread-watcher.mjs";
import { EVENT_ANSWER, EVENT_ASK, EVENT_PING, EVENT_PONG } from "../../src/core/protocol.mjs";

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

  it("the focused-mode watcher does the same", () => {
    const findPane = vi.fn(() => null);
    startUnreadWatcher({
      document: freshDocument(),
      onIncoming: () => {},
      read: () => new Map(),
      findPane,
      MutationObserverCtor: FakeObserver,
      isFocused: () => true,
    });
    findPane.mockClear();
    for (let i = 0; i < 20; i++) {
      mutate(50);
      vi.advanceTimersByTime(100);
    }
    expect(findPane.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

// ------------------------------------------------------------------ while WhatsApp is open

describe("reading the chat list while WhatsApp is busy", () => {
  function watch({ focused = true } = {}) {
    const doc = freshDocument(
      '<!DOCTYPE html><html><body><div id="pane-side"></div></body></html>'
    );
    const read = vi.fn(() => new Map());
    startUnreadWatcher({
      document: doc,
      onIncoming: () => {},
      read,
      MutationObserverCtor: FakeObserver,
      isFocused: () => focused,
    });
    read.mockClear();
    return read;
  }

  it("reads at most about twice a second however often the page changes", () => {
    const read = watch();
    for (let i = 0; i < 40; i++) {
      mutate(20);
      vi.advanceTimersByTime(50); // 2 s of constant changes
    }
    expect(read.mock.calls.length).toBeLessThanOrEqual(6);
    expect(read.mock.calls.length).toBeGreaterThan(0); // but it does keep up
  });

  it("reads even less while WhatsApp is not on screen", () => {
    const read = watch({ focused: false });
    for (let i = 0; i < 40; i++) {
      mutate(20);
      vi.advanceTimersByTime(50);
    }
    expect(read.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

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

  it("known chat names are tidied once, not on every read", () => {
    let t = 1_000;
    const names = ["Radwa", "Mom"];
    const mapSpy = vi.spyOn(names, "map");
    const model = createPageModel({ document: page(), knownNames: () => names, now: () => t });
    for (let i = 0; i < 5; i++) {
      model.readChats();
      t += 1_000;
    }
    expect(mapSpy.mock.calls.length).toBe(1);
  });

  it("finds chats by known names without reading the text of whole page sections", () => {
    const rows = Array.from(
      { length: 40 },
      (_, i) =>
        `<div class="r"><div><span dir="auto" title="Chat ${i}">Chat ${i}</span></div></div>`
    ).join("");
    const doc = freshDocument(
      `<!DOCTYPE html><html><body><div class="a"><div class="b"><div class="l">${rows}</div></div></div></body></html>`
    );
    const big = doc.querySelector(".l");
    const desc = Object.getOwnPropertyDescriptor(globalThis.Node.prototype, "textContent");
    let bigReads = 0;
    const spy = vi
      .spyOn(globalThis.Node.prototype, "textContent", "get")
      .mockImplementation(function () {
        if (this === big || this === big.parentElement || this === doc.body) bigReads += 1;
        return desc.get.call(this);
      });
    try {
      const model = createPageModel({ document: doc, knownNames: () => ["Chat 1", "Chat 2"] });
      expect(model.readChats().size).toBe(40);
      expect(bigReads).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

// ------------------------------------------------------------------ the bridge and the hook

describe("cheap answers to frequent questions", () => {
  it("the list of known chat names is built once and reused until something changes", async () => {
    const data = {
      settings: { enabled: true, volume: 1, defaultSoundId: null, showPopups: false },
      sounds: {},
      rules: [],
      knownChats: [{ name: "Family" }],
    };
    const doc = freshDocument();
    doc.addEventListener(EVENT_PING, () =>
      doc.dispatchEvent(
        new CustomEvent(EVENT_PONG, { detail: '{"notification":true,"play":true}' })
      )
    );
    const bridge = startBridge({
      chrome: {
        storage: {
          local: {
            get: vi.fn(async (keys) =>
              Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))
            ),
            set: vi.fn(async () => {}),
          },
          onChanged: { addListener: () => {}, removeListener: () => {} },
        },
        runtime: { id: "ext", sendMessage: vi.fn(async () => ({ ok: true })) },
      },
      document: doc,
      engine: { play: vi.fn(), invalidate: vi.fn(), canPlay: () => true },
      CustomEventCtor: CustomEvent,
    });
    await bridge.ready;
    const first = bridge.knownChatNames();
    expect(bridge.knownChatNames()).toBe(first);
    doc.dispatchEvent(
      new CustomEvent(EVENT_ASK, {
        detail: JSON.stringify({ kind: "notification", title: "Radwa", tag: "1@lid", body: "" }),
      })
    );
    const after = bridge.knownChatNames();
    expect(after).not.toBe(first);
    expect(after).toContain("Radwa");
    bridge.stop();
  });

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
