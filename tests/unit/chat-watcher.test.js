import { describe, it, expect, vi, beforeEach } from "vitest";
import { startChatWatcher } from "../../src/content/chat-watcher.mjs";
import { EVENT_REPLACE, MSG_CHATS, MSG_SCAN } from "../../src/core/protocol.mjs";

// Provided by the jsdom test environment (see vitest.config.js).
const { document } = globalThis;

const row = (name) =>
  `<div role="listitem"><div data-testid="cell-frame-title"><span dir="auto" title="${name}">${name}</span></div></div>`;
const pane = (...names) => `<div id="pane-side">${names.map(row).join("")}</div>`;

let observers;
let timers;
let chrome;
let messageListener;

class FakeObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    observers.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}

const setTimeoutFn = (fn) => {
  timers.push(fn);
  return timers.length;
};
const runTimers = () => timers.splice(0).forEach((fn) => fn());
const mutate = () => observers.filter((o) => !o.disconnected).forEach((o) => o.callback());
const sentNames = () => chrome.runtime.sendMessage.mock.calls.flatMap((c) => c[0].names);

function start(overrides = {}) {
  startChatWatcher({
    chrome,
    document,
    MutationObserverCtor: FakeObserver,
    setTimeoutFn,
    clearTimeoutFn: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  observers = [];
  timers = [];
  chrome = {
    runtime: {
      id: "ext",
      sendMessage: vi.fn(async () => {}),
      onMessage: { addListener: (fn) => (messageListener = fn), removeListener: vi.fn() },
    },
  };
});

describe("passive watching", () => {
  it("reports the chats that are already on screen", () => {
    document.body.innerHTML = pane("Radwa", "Family");
    start();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: MSG_CHATS,
      names: ["Radwa", "Family"],
    });
  });

  it("waits for WhatsApp to draw its chat list, then reports it", () => {
    start();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    document.body.innerHTML = pane("Mom");
    mutate();
    expect(sentNames()).toEqual(["Mom"]);
  });

  it("reports only names it has not reported before, after a short pause", () => {
    document.body.innerHTML = pane("Radwa");
    start();
    chrome.runtime.sendMessage.mockClear();

    document.body.innerHTML = pane("Radwa", "Newcomer");
    mutate();
    mutate(); // a burst of changes schedules only one check
    expect(timers).toHaveLength(1);
    runTimers();

    expect(sentNames()).toEqual(["Newcomer"]);
  });

  it("sends big lists in chunks", () => {
    document.body.innerHTML = pane(...Array.from({ length: 250 }, (_, i) => `Chat ${i}`));
    start();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(3);
    expect(sentNames()).toHaveLength(250);
  });

  it("survives the background being unreachable", () => {
    chrome.runtime.sendMessage.mockImplementation(() => {
      throw new Error("Extension context invalidated");
    });
    document.body.innerHTML = pane("Radwa");
    expect(() => start()).not.toThrow();
    chrome.runtime.sendMessage.mockImplementation(() => Promise.reject(new Error("no receiver")));
    document.body.innerHTML = pane("Radwa", "New");
    mutate();
    expect(() => runTimers()).not.toThrow();
  });
});

describe("an explicit scan request", () => {
  const request = (message = { type: MSG_SCAN }, sender = { id: "ext" }) =>
    new Promise((resolve) => {
      const keepOpen = messageListener(message, sender, resolve);
      if (keepOpen !== true) resolve(undefined);
    });

  it("scans the whole list, reports every name, and answers with the count", async () => {
    document.body.innerHTML = pane("Radwa");
    const scan = vi.fn(async () => ({ ok: true, names: ["Radwa", "Family", "Mom"] }));
    start({ scan });
    chrome.runtime.sendMessage.mockClear();

    const response = await request();

    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ document }));
    expect(response).toEqual({ ok: true, reason: undefined, count: 3 });
    expect(sentNames()).toEqual(["Radwa", "Family", "Mom"]);
  });

  it("reports why a scan found nothing", async () => {
    start({ scan: async () => ({ ok: false, reason: "no-chat-list", names: [] }) });
    expect(await request()).toEqual({ ok: false, reason: "no-chat-list", count: 0 });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("answers an error instead of leaving the caller waiting", async () => {
    start({
      scan: async () => {
        throw new Error("boom");
      },
    });
    expect(await request()).toEqual({ ok: false, reason: "error", count: 0 });
  });

  it("ignores other messages and messages from other extensions", async () => {
    const scan = vi.fn(async () => ({ ok: true, names: [] }));
    start({ scan });
    expect(await request({ type: "something-else" })).toBeUndefined();
    expect(await request({ type: MSG_SCAN }, { id: "evil" })).toBeUndefined();
    expect(scan).not.toHaveBeenCalled();
  });

  it("does not report a name twice after a scan already did", async () => {
    document.body.innerHTML = pane("Radwa");
    start({ scan: async () => ({ ok: true, names: ["Radwa", "Mom"] }) });
    await request();
    chrome.runtime.sendMessage.mockClear();
    document.body.innerHTML = pane("Radwa", "Mom");
    mutate();
    runTimers();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe("stopping", () => {
  it("stops when a newer copy announces itself", () => {
    document.body.innerHTML = pane("Radwa");
    start();
    document.dispatchEvent(new CustomEvent(EVENT_REPLACE));
    chrome.runtime.sendMessage.mockClear();
    document.body.innerHTML = pane("Radwa", "New");
    mutate();
    runTimers();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalled();
  });

  it("goes quiet once the extension is reloaded under it", () => {
    document.body.innerHTML = pane("Radwa");
    start();
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime = {}; // what an orphaned content script sees
    document.body.innerHTML = pane("Radwa", "New");
    mutate();
    runTimers();
    expect(chrome.runtime.sendMessage).toBeUndefined();
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });
});
