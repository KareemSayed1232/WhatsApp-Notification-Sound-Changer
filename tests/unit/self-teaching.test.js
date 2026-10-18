import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { startBridge } from "../../src/content/bridge.mjs";
import { scanChatList } from "../../src/content/chat-list.mjs";
import { startChatWatcher } from "../../src/content/chat-watcher.mjs";
import {
  findByFingerprint,
  fingerprintOf,
  sanitizeFingerprint,
} from "../../src/content/fingerprint.mjs";
import { createMuteLearner } from "../../src/content/mute-learner.mjs";
import { createPageModel, sanitizeLearned } from "../../src/content/page-model.mjs";
import { startUnreadWatcher } from "../../src/content/unread-watcher.mjs";
import { decideForChatName } from "../../src/core/matcher.mjs";
import { EVENT_ASK, EVENT_PING, EVENT_PONG } from "../../src/core/protocol.mjs";

// Phase 1 of the fragility plan: reading WhatsApp's chat list without depending on the exact
// names WhatsApp uses in its markup today. Every fixture below comes in two forms: the REAL markup
// captured from WhatsApp Web (Oct 2026), and a MUTATED copy with every id, test id, role and
// English label renamed or removed, standing in for a future WhatsApp update.

// ------------------------------------------------------------------ fixtures

const realRow = (name, { unread = 0, muted = false, preview = "hi", time = "12:30" } = {}) =>
  `<div role="row"><div role="gridcell"><div data-testid="cell-frame-container">` +
  `<div data-testid="cell-frame-title"><span dir="auto" title="${name}">${name}</span></div>` +
  `<div data-testid="cell-frame-primary-detail"><div data-testid="chat-list-timestamp">${time}</div></div>` +
  `<div data-testid="cell-frame-secondary"><span dir="auto" title="${preview}">${preview}</span>` +
  (muted
    ? `<span data-testid="mute-notifications-refreshed" aria-label="Muted chat"></span>`
    : "") +
  (unread
    ? `<span data-testid="icon-unread-count" aria-label="${unread} unread messages">${unread}</span>`
    : "") +
  `</div></div></div></div>`;

// The same row after a hypothetical WhatsApp update: no roles, no test ids, no labels.
const mutatedRow = (name, { unread = 0, preview = "hi", time = "12:30" } = {}) =>
  `<div class="r7"><div class="c1"><span dir="auto" title="${name}">${name}</span></div>` +
  `<div class="c2"><div>${time}</div></div>` +
  `<div class="c3"><span dir="auto" title="${preview}">${preview}</span>` +
  (unread ? `<span data-q="b">${unread}</span>` : "") +
  `</div></div>`;

const realPage = (rows, header = "") =>
  freshDocument(
    `<!DOCTYPE html><html><body><div id="app">` +
      `<div id="side"><div id="pane-side"><div role="grid">${rows}</div></div></div>` +
      `<div id="main">${header}</div></div></body></html>`
  );

const mutatedPage = (rows, header = "") =>
  freshDocument(
    `<!DOCTYPE html><html><body><div class="app">` +
      `<div class="s1"><div class="s2"><div class="list">${rows}</div></div></div>` +
      `<div class="m1">${header}</div></div></body></html>`
  );

const asObject = (chats) => Object.fromEntries([...chats.values()].map((c) => [c.name, c.count]));

// ------------------------------------------------------------------ fingerprints

describe("fingerprints: what an element looks like, never what it says", () => {
  const doc = realPage(realRow("Radwa", { unread: 2 }) + realRow("Mom", { unread: 5 }));
  const rows = [...doc.querySelectorAll('[role="row"]')];

  it("records the tag, the test id, which attributes it has and how deep it sits", () => {
    const badge = rows[0].querySelector('[data-testid="icon-unread-count"]');
    expect(fingerprintOf(badge, rows[0])).toEqual({
      tag: "SPAN",
      testid: "icon-unread-count",
      attrs: [],
      depth: 4,
    });
  });

  it("never contains chat names, label text or counts", () => {
    const name = rows[0].querySelector('span[title="Radwa"]');
    const badge = rows[0].querySelector('[data-testid="icon-unread-count"]');
    const text = JSON.stringify([fingerprintOf(name, rows[0]), fingerprintOf(badge, rows[0])]);
    for (const secret of ["Radwa", "unread messages", '"2"']) expect(text).not.toContain(secret);
  });

  it("finds the same-shaped element in another row", () => {
    const fp = fingerprintOf(rows[0].querySelector('[data-testid="icon-unread-count"]'), rows[0]);
    expect(findByFingerprint(rows[1], fp).textContent).toBe("5");
  });

  it("finds nothing when no element in the row has that shape", () => {
    const fp = { tag: "SPAN", testid: "something-else", attrs: [], depth: 4 };
    expect(findByFingerprint(rows[1], fp)).toBeNull();
    expect(findByFingerprint(rows[1], { ...fp, testid: "icon-unread-count", depth: 9 })).toBeNull();
  });

  it("only accepts well-formed stored fingerprints", () => {
    expect(sanitizeFingerprint({ tag: "SPAN", testid: null, attrs: ["data-q"], depth: 3 })).toEqual(
      { tag: "SPAN", testid: null, attrs: ["data-q"], depth: 3 }
    );
    for (const junk of [
      null,
      "x",
      { tag: "<b>" },
      { tag: "SPAN", depth: -1 },
      { tag: "SPAN", depth: 2, attrs: "x" },
    ]) {
      expect(sanitizeFingerprint(junk)).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ reading the list

describe("reading the chat list: real markup (no regression)", () => {
  it("reads names, unread counts and the muted marker exactly as before", () => {
    const doc = realPage(
      realRow("Radwa", { unread: 1 }) + realRow("Work", { unread: 2, muted: true }) + realRow("Mom")
    );
    const chats = createPageModel({ document: doc }).readChats();
    expect(asObject(chats)).toEqual({ Radwa: 1, Work: 2, Mom: 0 });
    expect([...chats.values()].find((c) => c.name === "Work").muted).toBe(true);
    expect([...chats.values()].find((c) => c.name === "Radwa").muted).toBe(false);
  });

  it("does not mistake the time or a message saying '5' for an unread count", () => {
    const doc = realPage(realRow("Radwa", { preview: "5", time: "5" }));
    expect(asObject(createPageModel({ document: doc }).readChats())).toEqual({ Radwa: 0 });
  });
});

describe("reading the chat list after WhatsApp renames everything", () => {
  const knownNames = () => ["Radwa", "Mom", "Family"];

  it("finds the list, the rows, the names and the counters from known chat names alone", () => {
    const doc = mutatedPage(
      mutatedRow("Radwa", { unread: 3 }) + mutatedRow("Mom") + mutatedRow("Family", { unread: 12 })
    );
    const chats = createPageModel({ document: doc, knownNames }).readChats();
    expect(asObject(chats)).toEqual({ Radwa: 3, Mom: 0, Family: 12 });
  });

  it("also reads chats it does not know yet, once the list is found", () => {
    const doc = mutatedPage(
      mutatedRow("Radwa") + mutatedRow("Mom") + mutatedRow("New person", { unread: 1 })
    );
    const chats = createPageModel({ document: doc, knownNames }).readChats();
    expect(asObject(chats)).toEqual({ Radwa: 0, Mom: 0, "New person": 1 });
  });

  it("is not fooled by the open chat's header showing a known name", () => {
    const doc = mutatedPage(
      mutatedRow("Radwa", { unread: 1 }) + mutatedRow("Mom") + mutatedRow("Family"),
      `<header><span dir="auto" title="Radwa">Radwa</span></header>`
    );
    const chats = createPageModel({ document: doc, knownNames }).readChats();
    expect(asObject(chats)).toEqual({ Radwa: 1, Mom: 0, Family: 0 });
  });

  it("ignores message previews that are only digits, and times", () => {
    const doc = mutatedPage(
      mutatedRow("Radwa", { preview: "42", time: "5" }) + mutatedRow("Mom", { unread: 2 })
    );
    expect(asObject(createPageModel({ document: doc, knownNames }).readChats())).toEqual({
      Radwa: 0,
      Mom: 2,
    });
  });

  it("needs at least two known chats on screen to trust a list it found this way", () => {
    const doc = mutatedPage(mutatedRow("Radwa", { unread: 1 }) + mutatedRow("Stranger"));
    expect(createPageModel({ document: doc, knownNames }).readChats().size).toBe(0);
  });

  it("works in any language: no English label is needed anywhere", () => {
    const doc = mutatedPage(
      `<div class="r7"><span dir="auto" title="رضوى">رضوى</span><span data-q="b">4</span></div>` +
        mutatedRow("Mom")
    );
    const chats = createPageModel({ document: doc, knownNames: () => ["رضوى", "Mom"] }).readChats();
    expect(asObject(chats)).toEqual({ رضوى: 4, Mom: 0 });
  });

  it("returns nothing (and does not throw) on a page with no chat list", () => {
    expect(createPageModel({ document: freshDocument(), knownNames }).readChats().size).toBe(0);
  });
});

describe("learning from notifications", () => {
  const knownNames = () => ["Radwa", "Mom"];
  // The same row shape the counter was learned from, plus a decoy number after the counter.
  // Structure alone picks the last number; the learned fingerprint picks the right one.
  const trickyRow = (name, unread) =>
    `<div class="r7"><div class="c1"><span dir="auto" title="${name}">${name}</span></div>` +
    `<div class="c3"><span data-q="b">${unread}</span><i>9</i></div></div>`;

  it("learns what the counter looks like after two notifications agree", () => {
    const onLearn = vi.fn();
    const doc = mutatedPage(mutatedRow("Radwa", { unread: 1 }) + mutatedRow("Mom", { unread: 2 }));
    const model = createPageModel({ document: doc, knownNames, onLearn });

    model.learnFrom("Radwa");
    expect(model.learned().counter).toBeNull(); // one observation is not enough
    model.learnFrom("Mom");
    expect(model.learned().counter).toMatchObject({ tag: "SPAN", attrs: ["data-q"] });
    expect(onLearn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onLearn.mock.calls)).not.toMatch(/Radwa|Mom/);
  });

  it("then uses what it learned before falling back to guesswork", () => {
    const doc = mutatedPage(mutatedRow("Radwa", { unread: 1 }) + mutatedRow("Mom", { unread: 2 }));
    const model = createPageModel({ document: doc, knownNames });
    model.learnFrom("Radwa");
    model.learnFrom("Mom");

    const tricky = mutatedPage(trickyRow("Radwa", 3) + trickyRow("Mom", 1));
    const later = createPageModel({ document: tricky, knownNames, learned: model.learned() });
    expect(asObject(later.readChats())).toEqual({ Radwa: 3, Mom: 1 });

    const guessing = createPageModel({ document: tricky, knownNames });
    expect(asObject(guessing.readChats())).toEqual({ Radwa: 9, Mom: 9 }); // why learning matters
  });

  it("learns the name element too, and keeps reading names if their title disappears", () => {
    const named = (n) => `<div class="r7"><b data-n="1">${n}</b><span data-q="b">1</span></div>`;
    const doc = mutatedPage(named("Radwa") + named("Mom"));
    const model = createPageModel({ document: doc, knownNames });
    model.learnFrom("Radwa");
    model.learnFrom("Mom");
    expect(model.learned().name).toMatchObject({ tag: "B", attrs: ["data-n"] });

    const later = createPageModel({
      document: mutatedPage(named("Radwa") + named("Mom") + named("Someone new")),
      knownNames,
      learned: model.learned(),
    });
    expect([...later.readChats().values()].map((c) => c.name)).toContain("Someone new");
  });

  it("ignores a notification for a chat that is not on screen", () => {
    const doc = mutatedPage(mutatedRow("Radwa", { unread: 1 }) + mutatedRow("Mom", { unread: 1 }));
    const model = createPageModel({ document: doc, knownNames });
    expect(() => model.learnFrom("Nobody")).not.toThrow();
    expect(model.learned()).toEqual({ name: null, counter: null });
  });

  it("only restores well-formed learned data", () => {
    expect(sanitizeLearned({ name: { tag: "<x>" }, counter: "junk" })).toEqual({
      name: null,
      counter: null,
    });
  });
});

// ------------------------------------------------------------------ mutes from behaviour

describe("learning which chats are muted from WhatsApp's own behaviour", () => {
  let timers;
  let clock;
  let learner;
  let changes;

  const setTimeoutFn = (fn, ms) => {
    timers.push({ fn, at: clock.t + ms });
    return timers.length;
  };
  const advance = (ms) => {
    clock.t += ms;
    for (const t of timers.filter((t) => t.at <= clock.t)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };

  function start(options = {}) {
    learner = createMuteLearner({
      now: () => clock.t,
      setTimeoutFn,
      onChange: (snapshot) => changes.push(snapshot),
      ...options,
    });
  }

  beforeEach(() => {
    timers = [];
    clock = { t: 100_000 };
    changes = [];
  });

  it("knows nothing at first", () => {
    start();
    expect(learner.isMuted("Mohanad")).toBeUndefined();
  });

  it("a new message in the background with no notification means the chat is muted", () => {
    start();
    learner.noteBackgroundRise("Mohanad");
    advance(2_100);
    expect(learner.isMuted("Mohanad")).toBe(true);
  });

  it("a notification for it (before or after) means it is not muted", () => {
    start();
    learner.noteNotification("Radwa");
    learner.noteBackgroundRise("Radwa");
    advance(2_100);
    expect(learner.isMuted("Radwa")).toBe(false);

    learner.noteBackgroundRise("Mom");
    advance(500);
    learner.noteNotification("Mom");
    advance(2_000);
    expect(learner.isMuted("Mom")).toBe(false);
  });

  it("notices when a chat is unmuted again", () => {
    start({ initial: { mohanad: true } });
    expect(learner.isMuted("Mohanad")).toBe(true);
    learner.noteNotification("Mohanad");
    expect(learner.isMuted("Mohanad")).toBe(false);
  });

  it("matches names regardless of case and invisible marks", () => {
    start();
    learner.noteBackgroundRise("Mohanad‎");
    advance(2_100);
    expect(learner.isMuted("mohanad")).toBe(true);
  });

  it("learns nothing while notifications cannot be trusted to arrive", () => {
    start({ canLearn: () => false });
    learner.noteBackgroundRise("Mohanad");
    advance(2_100);
    expect(learner.isMuted("Mohanad")).toBeUndefined();
  });

  it("reports changes so they can be saved, and only real changes", () => {
    start();
    learner.noteBackgroundRise("Mohanad");
    advance(2_100);
    learner.noteBackgroundRise("Mohanad");
    advance(2_100);
    expect(changes).toEqual([{ mohanad: true }]);
  });

  it("stops cleanly", () => {
    start();
    learner.noteBackgroundRise("Mohanad");
    learner.stop();
    advance(2_100);
    expect(learner.isMuted("Mohanad")).toBeUndefined();
  });
});

// ------------------------------------------------------------------ the watcher uses it all

describe("the unread watcher with a learned page model and learned mutes", () => {
  const { document } = globalThis;
  let observers;
  let timers;
  let focused;
  let incoming;
  let rises;
  let watcher;
  let chats;

  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.callback = () => {};
    }
  }
  const settle = () => {
    observers.forEach((o) => o.callback());
    timers.splice(0).forEach((fn) => fn());
  };
  const show = (list) => {
    chats = new Map(list.map((c) => [c.name.toLowerCase(), { muted: false, ...c }]));
    settle();
  };

  function start(isMuted) {
    document.body.innerHTML = '<div id="pane-side"></div>';
    watcher = startUnreadWatcher({
      document,
      read: () => chats,
      isMuted,
      onIncoming: (name) => incoming.push(name),
      onRise: (rise) => rises.push(rise),
      MutationObserverCtor: FakeObserver,
      setTimeoutFn: (fn) => timers.push(fn),
      clearTimeoutFn: () => {},
      now: () => 50_000,
      isFocused: () => focused,
    });
  }

  beforeEach(() => {
    observers = [];
    timers = [];
    focused = true;
    incoming = [];
    rises = [];
    chats = new Map();
  });
  afterEach(() => watcher?.stop());

  it("reads chats through the page model it is given", () => {
    show([{ name: "Radwa", count: 0 }]);
    start();
    show([{ name: "Radwa", count: 1 }]);
    expect(incoming).toEqual(["Radwa"]);
  });

  it("reports every rise, focused or not, so mutes can be learned in the background", () => {
    show([{ name: "Radwa", count: 0 }]);
    start();
    focused = false;
    show([{ name: "Radwa", count: 1 }]);
    focused = true;
    show([{ name: "Radwa", count: 2 }]);
    expect(rises).toEqual([
      { name: "Radwa", focused: false, muted: false },
      { name: "Radwa", focused: true, muted: false },
    ]);
    expect(incoming).toEqual(["Radwa"]);
  });

  it("a learned 'muted' wins over a page that shows no mute marker", () => {
    show([{ name: "Mohanad", count: 0 }]);
    start((name, chat) => (name === "Mohanad" ? true : chat.muted));
    show([{ name: "Mohanad", count: 1 }]);
    expect(incoming).toEqual([]);
  });

  it("a learned 'not muted' wins over a stale mute marker", () => {
    show([{ name: "Mohanad", count: 0, muted: true }]);
    start((name) => (name === "Mohanad" ? false : true));
    show([{ name: "Mohanad", count: 1, muted: true }]);
    expect(incoming).toEqual(["Mohanad"]);
  });
});

// ------------------------------------------------------------------ the bridge feeds the learning

describe("the bridge tells the page model about notifications and known chats", () => {
  let doc;
  let bridge;
  let engine;
  let seen;
  const sounds = { s1: { id: "s1" }, s2: { id: "s2" } };
  const rule = (id, chatId, soundId) => ({
    id,
    kind: "chat",
    match: "Ahmed",
    chatId,
    action: "sound",
    soundId,
    enabled: true,
  });

  async function boot(rules = []) {
    const data = {
      settings: { enabled: true, volume: 1, defaultSoundId: null, showPopups: false },
      sounds,
      rules,
      knownChats: [{ name: "Family" }],
      recentSenders: [{ name: "Radwa", kind: "chat", chatId: "1@lid", lastSeen: 1 }],
    };
    doc = freshDocument();
    doc.addEventListener(EVENT_PING, () =>
      doc.dispatchEvent(
        new CustomEvent(EVENT_PONG, { detail: JSON.stringify({ notification: true, play: true }) })
      )
    );
    engine = { play: vi.fn(async () => true), invalidate: vi.fn(), canPlay: () => true };
    seen = [];
    bridge = startBridge({
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
      engine,
      CustomEventCtor: CustomEvent,
      onNotification: (n) => seen.push(n),
    });
    await bridge.ready;
  }

  const notify = (title, tag) =>
    doc.dispatchEvent(
      new CustomEvent(EVENT_ASK, {
        detail: JSON.stringify({ kind: "notification", title, tag, body: "private text" }),
      })
    );

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    bridge?.stop();
    vi.useRealTimers();
  });

  it("passes each notification's chat name and id on, never the message", async () => {
    await boot();
    notify("Radwa", "1@lid");
    expect(seen).toEqual([{ title: "Radwa", tag: "1@lid" }]);
  });

  it("lists the chat names it knows, for finding the list by structure", async () => {
    await boot([rule("r1", "9@lid", "s1")]);
    notify("Someone", "5@lid");
    expect(bridge.knownChatNames().sort()).toEqual(["Ahmed", "Family", "Radwa", "Someone"]);
  });

  it("two chats with the same name: plays the one that last notified", async () => {
    await boot([rule("r1", "1@lid", "s1"), rule("r2", "2@lid", "s2")]);
    notify("Ahmed", "2@lid");
    await vi.advanceTimersByTimeAsync(5_000); // long after, so it is not mistaken for a duplicate
    bridge.onIncomingChat("Ahmed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.play).toHaveBeenCalledWith("s2", 1);
  });

  it("decideForChatName prefers the chat id it is given", () => {
    const rules = [rule("r1", "1@lid", "s1"), rule("r2", "2@lid", "s2")];
    const settings = { enabled: true, volume: 1 };
    expect(decideForChatName({ name: "Ahmed", rules, sounds, settings }).soundId).toBe("s1");
    expect(
      decideForChatName({ name: "Ahmed", rules, sounds, settings, preferChatId: "2@lid" }).soundId
    ).toBe("s2");
  });
});

// ------------------------------------------------------------------ "Refresh chats" and the name collector

describe("Refresh and the name collector read through the self-teaching model", () => {
  const knownNames = () => ["Radwa", "Mom"];

  it("Refresh (scanChatList) lists chats on a page with every WhatsApp name removed", async () => {
    const doc = mutatedPage(mutatedRow("Radwa") + mutatedRow("Mom") + mutatedRow("New person"));
    const model = createPageModel({ document: doc, knownNames });
    const result = await scanChatList({
      document: doc,
      wait: async () => {},
      readNames: model.readNames,
      findPane: model.findPane,
    });
    expect(result).toEqual({ ok: true, names: ["Radwa", "Mom", "New person"] });
  });

  it("the name collector reports chats from the same page", () => {
    const doc = mutatedPage(mutatedRow("Radwa") + mutatedRow("Mom"));
    const model = createPageModel({ document: doc, knownNames });
    const sent = [];
    const watcher = startChatWatcher({
      chrome: {
        runtime: {
          id: "ext",
          sendMessage: (m) => sent.push(...m.names),
          onMessage: { addListener: () => {}, removeListener: () => {} },
        },
      },
      document: doc,
      MutationObserverCtor: class {
        observe() {}
        disconnect() {}
      },
      setTimeoutFn: (fn) => fn(),
      clearTimeoutFn: () => {},
      readNames: model.readNames,
      findPane: model.findPane,
    });
    expect(sent).toEqual(["Radwa", "Mom"]);
    watcher?.stop?.();
  });
});
