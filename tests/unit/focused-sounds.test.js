import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { startBridge } from "../../src/content/bridge.mjs";
import { readUnreadCounts } from "../../src/content/chat-list.mjs";
import { startUnreadWatcher } from "../../src/content/unread-watcher.mjs";
import { decideForChatName } from "../../src/core/matcher.mjs";
import { EVENT_ANSWER, EVENT_ASK, EVENT_PING, EVENT_PONG } from "../../src/core/protocol.mjs";

// When WhatsApp is focused, Firefox's WhatsApp raises no notification and plays no sound for a
// new message (measured Oct 2026). The only sign is the chat's unread counter going up, so the
// extension plays the chat's sound itself.

// Captured from WhatsApp Web, Oct 2026 (names changed).
const chatRow = (name, unread = 0, { muted = false } = {}) =>
  `<div role="row"><div role="gridcell"><div data-testid="cell-frame-container">` +
  `<div data-testid="cell-frame-title"><span dir="auto" title="${name}">${name}</span></div>` +
  `<div data-testid="cell-frame-secondary"><span dir="auto" title="hi">hi</span>` +
  // A muted chat's marker, captured from a real muted chat (Firefox, Oct 2026).
  (muted
    ? `<span data-testid="mute-notifications-refreshed" aria-label="Muted chat"></span>`
    : "") +
  (unread
    ? `<span data-testid="icon-unread-count" aria-label="${unread} unread message${unread === 1 ? "" : "s"}">${unread}</span>`
    : "") +
  `</div></div></div></div>`;
const archivedButton = (count) =>
  `<button aria-label="Archived" type="button"><div data-testid="cell-frame-container">` +
  `<div data-testid="cell-frame-title"><span dir="auto" title="Archived">Archived</span></div>` +
  `<span data-testid="icon-unread-count">${count}</span></div></button>`;
const listHtml = (rows) =>
  `<div id="side"><div id="pane-side"><div role="grid">${rows}</div></div></div>`;

// ------------------------------------------------------------------ reading the counters

describe("reading unread counters from the chat list", () => {
  const page = (rows) =>
    freshDocument(`<!DOCTYPE html><html><body>${listHtml(rows)}</body></html>`);
  const counts = (doc) =>
    Object.fromEntries([...readUnreadCounts(doc).values()].map((c) => [c.name, c.count]));

  it("reads each chat's unread number, 0 when it has none", () => {
    expect(counts(page(chatRow("Radwa", 1) + chatRow("Family", 14) + chatRow("Mom")))).toEqual({
      Radwa: 1,
      Family: 14,
      Mom: 0,
    });
  });

  it("falls back to the 'N unread messages' label when the test id changes", () => {
    const doc = page(
      `<div role="row"><span dir="auto" title="Dad">Dad</span><span aria-label="3 unread messages">3</span></div>`
    );
    expect(counts(doc)).toEqual({ Dad: 3 });
  });

  it("treats a 'marked as unread' dot (no number) as nothing new", () => {
    const doc = page(
      `<div role="row"><span dir="auto" title="Dad">Dad</span><span data-testid="icon-unread-count"></span></div>`
    );
    expect(counts(doc)).toEqual({ Dad: 0 });
  });

  it("ignores the Archived entry and its counter", () => {
    expect(counts(page(archivedButton(5) + chatRow("Mom", 1)))).toEqual({ Mom: 1 });
  });

  it("marks muted chats", () => {
    const entries = [...readUnreadCounts(page(chatRow("Work", 2, { muted: true }))).values()];
    expect(entries).toEqual([{ name: "Work", count: 2, muted: true }]);
  });

  it("returns nothing when the chat list is not there", () => {
    expect(readUnreadCounts(freshDocument()).size).toBe(0);
  });
});

// ------------------------------------------------------------------ choosing the sound by name

describe("choosing a chat's sound from its name alone", () => {
  const sounds = { s1: { id: "s1" }, s2: { id: "s2" } };
  const settings = { enabled: true, volume: 1, defaultSoundId: "s2" };
  const rule = (extra) => ({
    id: "r1",
    kind: "chat",
    match: "Radwa",
    chatId: "601@lid",
    action: "sound",
    soundId: "s1",
    enabled: true,
    ...extra,
  });

  it("finds a rule even when it is tied to a chat id", () => {
    expect(decideForChatName({ name: "Radwa", rules: [rule()], sounds, settings })).toMatchObject({
      action: "play",
      soundId: "s1",
    });
  });

  it("ignores case and invisible marks in the name", () => {
    expect(decideForChatName({ name: "radwa‎", rules: [rule()], sounds, settings }).soundId).toBe(
      "s1"
    );
  });

  it("uses the default sound for a chat without its own", () => {
    expect(decideForChatName({ name: "Mom", rules: [rule()], sounds, settings })).toMatchObject({
      action: "play",
      soundId: "s2",
    });
  });

  it("respects silent rules and the off switch", () => {
    expect(
      decideForChatName({ name: "Radwa", rules: [rule({ action: "silent" })], sounds, settings })
        .action
    ).toBe("silent");
    expect(
      decideForChatName({
        name: "Radwa",
        rules: [rule()],
        sounds,
        settings: { ...settings, enabled: false },
      }).action
    ).toBe("native");
  });

  it("does not let a group-member rule match a chat name", () => {
    const sender = rule({ kind: "sender", chatId: null, match: "Bob" });
    expect(
      decideForChatName({ name: "Bob", rules: [sender], sounds, settings: { enabled: true } })
        .action
    ).toBe("native");
  });
});

// ------------------------------------------------------------------ the watcher

describe("watching the unread counters", () => {
  const { document } = globalThis;
  let observers;
  let timers;
  let clock;
  let focused;
  let incoming;
  let watcher;

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
  const settle = () => {
    observers.filter((o) => !o.disconnected).forEach((o) => o.callback());
    timers.splice(0).forEach((fn) => fn());
  };
  const render = (rows) => {
    document.body.innerHTML = listHtml(rows);
    settle();
  };

  function start() {
    watcher = startUnreadWatcher({
      document,
      onIncoming: (name) => incoming.push(name),
      MutationObserverCtor: FakeObserver,
      setTimeoutFn,
      clearTimeoutFn: () => {},
      now: () => clock.t,
      isFocused: () => focused,
    });
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    observers = [];
    timers = [];
    clock = { t: 10_000 };
    focused = true;
    incoming = [];
  });

  afterEach(() => watcher?.stop());

  it("takes the first look as a baseline: existing unread chats make no sound", () => {
    render(chatRow("Radwa", 2) + chatRow("Mom", 1));
    start();
    settle();
    expect(incoming).toEqual([]);
  });

  it("reports a chat whose counter goes up while WhatsApp is focused", () => {
    render(chatRow("Radwa") + chatRow("Mom", 1));
    start();
    render(chatRow("Radwa", 1) + chatRow("Mom", 1));
    expect(incoming).toEqual(["Radwa"]);
    render(chatRow("Radwa", 2) + chatRow("Mom", 1));
    expect(incoming).toEqual(["Radwa", "Radwa"]);
  });

  it("reports a chat that jumps to the top of the list with a new message", () => {
    render(chatRow("Mom"));
    start();
    render(chatRow("Radwa", 1) + chatRow("Mom"));
    expect(incoming).toEqual(["Radwa"]);
  });

  it("stays quiet when a counter goes down (the chat was read)", () => {
    render(chatRow("Radwa", 3));
    start();
    render(chatRow("Radwa"));
    expect(incoming).toEqual([]);
  });

  it("stays quiet while WhatsApp is not focused (notifications handle that), but keeps up", () => {
    render(chatRow("Radwa"));
    start();
    focused = false;
    render(chatRow("Radwa", 1));
    focused = true;
    settle();
    expect(incoming).toEqual([]);
  });

  it("stays quiet for muted chats, like WhatsApp", () => {
    render(chatRow("Work", 0, { muted: true }));
    start();
    render(chatRow("Work", 1, { muted: true }));
    expect(incoming).toEqual([]);
  });

  it("does not treat rows scrolled into view as new messages", () => {
    render(chatRow("Mom"));
    start();
    document.getElementById("pane-side").dispatchEvent(new Event("scroll"));
    render(chatRow("Mom") + chatRow("Old unread", 4));
    expect(incoming).toEqual([]);
  });

  it("does not treat search results as new messages", () => {
    render(chatRow("Mom"));
    start();
    document.getElementById("side").dispatchEvent(new Event("input", { bubbles: true }));
    render(chatRow("Old unread", 4));
    expect(incoming).toEqual([]);
  });

  it("reacts again once the user stopped scrolling or searching for a moment", () => {
    render(chatRow("Mom"));
    start();
    document.getElementById("pane-side").dispatchEvent(new Event("scroll"));
    clock.t += 1_500;
    render(chatRow("Mom", 1));
    expect(incoming).toEqual(["Mom"]);
  });

  it("starts watching once WhatsApp renders the chat list", () => {
    start();
    render(chatRow("Radwa"));
    render(chatRow("Radwa", 1));
    expect(incoming).toEqual(["Radwa"]);
  });

  it("never reports the Archived entry", () => {
    render(archivedButton(1) + chatRow("Mom"));
    start();
    render(archivedButton(2) + chatRow("Mom"));
    expect(incoming).toEqual([]);
  });

  it("stops completely", () => {
    render(chatRow("Radwa"));
    start();
    watcher.stop();
    render(chatRow("Radwa", 1));
    expect(incoming).toEqual([]);
  });

  it("a failing callback does not stop it", () => {
    render(chatRow("A") + chatRow("B"));
    watcher = startUnreadWatcher({
      document,
      onIncoming: (name) => {
        incoming.push(name);
        if (name === "A") throw new Error("boom");
      },
      MutationObserverCtor: FakeObserver,
      setTimeoutFn,
      clearTimeoutFn: () => {},
      now: () => clock.t,
      isFocused: () => true,
    });
    render(chatRow("A", 1) + chatRow("B", 1));
    expect(incoming).toEqual(["A", "B"]);
  });
});

// ------------------------------------------------------------------ the bridge plays it

describe("playing the chat's sound for a focused message", () => {
  const sounds = { s1: { id: "s1", name: "Ping", mime: "audio/mpeg", size: 3 } };
  const radwa = {
    id: "r1",
    kind: "chat",
    match: "Radwa",
    chatId: "601@lid",
    action: "sound",
    soundId: "s1",
    enabled: true,
  };
  let doc;
  let data;
  let engine;
  let bridge;

  async function boot({ rules = [radwa], settings = {}, canPlay = true } = {}) {
    data = {
      settings: {
        enabled: true,
        volume: 0.7,
        defaultSoundId: null,
        showPopups: false,
        ...settings,
      },
      sounds,
      rules,
    };
    doc = freshDocument();
    doc.addEventListener(EVENT_PING, () =>
      doc.dispatchEvent(
        new CustomEvent(EVENT_PONG, { detail: JSON.stringify({ notification: true, play: true }) })
      )
    );
    engine = { play: vi.fn(async () => true), invalidate: vi.fn(), canPlay: () => canPlay };
    bridge = startBridge({
      chrome: {
        storage: {
          local: {
            get: vi.fn(async (keys) =>
              Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))
            ),
            set: vi.fn(async (items) => Object.assign(data, items)),
          },
          onChanged: { addListener: () => {}, removeListener: () => {} },
        },
        runtime: { id: "ext", sendMessage: vi.fn(async () => ({ ok: true })) },
      },
      document: doc,
      engine,
      CustomEventCtor: CustomEvent,
    });
    await bridge.ready;
  }

  const whatsappAsks = (payload) =>
    doc.dispatchEvent(new CustomEvent(EVENT_ASK, { detail: JSON.stringify(payload) }));

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    bridge?.stop();
    vi.useRealTimers();
  });

  it("plays the chat's own sound, even though its rule is tied to a chat id", async () => {
    await boot();
    bridge.onIncomingChat("Radwa");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.play).toHaveBeenCalledWith("s1", 0.7);
  });

  it("waits a moment, and stays quiet if WhatsApp did make (and we handled) a sound", async () => {
    await boot();
    bridge.onIncomingChat("Radwa");
    whatsappAsks({ kind: "default-sound" }); // Edge/Chrome still play WhatsApp's sound when focused
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.play).not.toHaveBeenCalled();
  });

  it("also stays quiet if a notification for it just came through", async () => {
    await boot();
    whatsappAsks({ kind: "notification", title: "Radwa", tag: "601@lid", body: "hi" });
    bridge.onIncomingChat("Radwa");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.play).not.toHaveBeenCalled();
  });

  it("plays nothing for a chat with no sound when there is no default (WhatsApp played none)", async () => {
    await boot();
    bridge.onIncomingChat("Mom");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.play).not.toHaveBeenCalled();
  });

  it("plays the default sound for other chats when one is set", async () => {
    await boot({ settings: { defaultSoundId: "s1" } });
    bridge.onIncomingChat("Mom");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.play).toHaveBeenCalledWith("s1", 0.7);
  });

  it("plays nothing for silent chats, or when the extension is off", async () => {
    await boot({ rules: [{ ...radwa, action: "silent", soundId: null }] });
    bridge.onIncomingChat("Radwa");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.play).not.toHaveBeenCalled();
    bridge.stop();
    await boot({ settings: { enabled: false } });
    bridge.onIncomingChat("Radwa");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.play).not.toHaveBeenCalled();
  });

  it("does not try when the browser is blocking audio, and says so on the status line", async () => {
    await boot({ canPlay: false });
    bridge.onIncomingChat("Radwa");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(engine.play).not.toHaveBeenCalled();
    expect(data.health.failedRun).toBe(1);
  });

  it("counts it as working on the status line", async () => {
    await boot();
    bridge.onIncomingChat("Radwa");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(data.health.lastPairedAt).toBeGreaterThan(0);
    expect(data.health.shapes.sound.via).toBe("self");
  });

  it("does nothing once stopped", async () => {
    await boot();
    bridge.onIncomingChat("Radwa");
    bridge.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.play).not.toHaveBeenCalled();
  });

  it("answers WhatsApp normally in between (asking is not affected)", async () => {
    await boot();
    let answer = null;
    doc.addEventListener(EVENT_ANSWER, (e) => (answer = JSON.parse(e.detail)));
    whatsappAsks({ kind: "permission" });
    expect(answer).toEqual({ spoof: true });
  });
});
