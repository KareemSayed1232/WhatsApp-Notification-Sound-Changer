import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { startBridge } from "../../src/content/bridge.mjs";
import { installMainHook } from "../../src/content/main-hook.mjs";
import { createPageModel } from "../../src/content/page-model.mjs";
import {
  applySignal,
  buildDiagnostics,
  emptyHealth,
  healthStatus,
  sanitizeHealth,
} from "../../src/core/health.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PING,
  EVENT_PLAY,
  EVENT_PONG,
  EVENT_SIGNAL,
} from "../../src/core/protocol.mjs";
import { healthMessage } from "../../src/ui/health-ui.mjs";
import { STRINGS as S } from "../../src/ui/strings.mjs";

// Phase 3 of the fragility plan: timing that adapts to WhatsApp instead of fixed numbers, and a
// status line that says precisely what went wrong.

const INCOMING = "https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3";
const OTHER = "https://static.whatsapp.net/rsrc.php/x/sent-tick.mp3";
const PLAY = { action: "play", soundId: "s1", volume: 1 };

// ------------------------------------------------------------------ adaptive timing (hook)

describe("timing that adapts to how fast WhatsApp plays its sound", () => {
  let doc;
  let win;
  let clock;
  let hook;
  let plays;
  let natives;
  let signals;
  let store;

  class FakeMedia {
    constructor(src) {
      this.src = src;
      this.currentSrc = src;
      this.isConnected = false;
    }
    play() {
      natives.push(this.src);
      return Promise.resolve();
    }
  }

  function install() {
    hook = installMainHook({ window: win, document: doc, now: () => clock.t });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    doc = freshDocument();
    store = {};
    win = {
      Notification: class {
        static permission = "denied";
      },
      HTMLMediaElement: FakeMedia,
      CustomEvent,
      localStorage: {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => (store[k] = String(v)),
      },
    };
    clock = { t: 100_000 };
    plays = [];
    natives = [];
    signals = [];
    doc.addEventListener(EVENT_PLAY, (e) => plays.push(JSON.parse(e.detail)));
    doc.addEventListener(EVENT_SIGNAL, (e) => signals.push(JSON.parse(e.detail)));
    doc.addEventListener(EVENT_ASK, (e) => {
      const q = JSON.parse(e.detail);
      const answer =
        q.kind === "notification"
          ? { mode: "managed", decision: PLAY }
          : q.kind === "default-sound"
            ? { decision: { action: "native" } }
            : null;
      if (answer) {
        doc.dispatchEvent(new CustomEvent(EVENT_ANSWER, { detail: JSON.stringify(answer) }));
      }
    });
    install();
  });
  afterEach(() => {
    hook.uninstall();
    vi.useRealTimers();
  });

  /** A notification, then WhatsApp's sound `delay` ms later. */
  async function message(delay, url = INCOMING) {
    new win.Notification("Radwa", { tag: "1@lid", silent: true });
    clock.t += delay;
    vi.advanceTimersByTime(delay);
    await new FakeMedia(url).play();
    clock.t += 10_000;
    vi.advanceTimersByTime(10_000);
  }

  it("starts with today's half-second window while WhatsApp is fast", async () => {
    await message(20); // WhatsApp measured 2-26 ms (Oct 2026)
    expect(plays).toHaveLength(1);
    await message(600);
    expect(plays).toHaveLength(1); // too late, left alone
  });

  it("learns from WhatsApp's sound arriving late, and catches it next time", async () => {
    await message(800); // missed, but measured
    expect(plays).toHaveLength(0);
    await message(800);
    expect(plays).toHaveLength(1);
    expect(natives).toEqual([INCOMING]); // the first one played as WhatsApp's own
  });

  it("does not learn from a different WhatsApp sound (e.g. 'message sent')", async () => {
    await message(800, OTHER);
    await message(800);
    expect(plays).toHaveLength(0);
  });

  it("never waits more than two seconds", async () => {
    await message(4_000);
    await message(2_500);
    expect(plays).toHaveLength(0);
    await message(1_900);
    expect(plays).toHaveLength(1);
  });

  it("waits longer before playing on its own when WhatsApp is slower, so nothing plays twice", async () => {
    await message(400); // paired; WhatsApp takes 400 ms
    plays.length = 0;
    // A notification meant to make a sound (not silent), WhatsApp's own sound 400 ms later.
    new win.Notification("Radwa", { tag: "1@lid" });
    clock.t += 300;
    vi.advanceTimersByTime(300);
    expect(plays).toHaveLength(0); // the old fixed 150 ms would have played already
    clock.t += 100;
    vi.advanceTimersByTime(100);
    await new FakeMedia(INCOMING).play();
    expect(plays).toHaveLength(1);
  });

  it("remembers the measurement across a reload, and ignores nonsense", async () => {
    await message(800);
    expect(JSON.parse(store.wanscTiming)).toContain(800);
    hook.uninstall();
    install();
    await message(800);
    expect(plays).toHaveLength(1);

    plays.length = 0;
    store.wanscTiming = '["x", -5, 99999]';
    hook.uninstall();
    install();
    await message(800);
    expect(plays).toHaveLength(0); // nonsense dropped: back to the half-second window
  });

  it("reports the measured delay for the diagnostics", async () => {
    await message(120);
    expect(signals).toContainEqual({ type: "timing", delay: 120 });
    const health = applySignal(emptyHealth(), { type: "timing", delay: 120 }, 1);
    expect(buildDiagnostics({ health, now: 2 }).timing).toEqual({ whatsappSoundDelayMs: 120 });
  });
});

// ------------------------------------------------------------------ blocked vs broken

describe("the status line says WHY our sound did not play", () => {
  const fold = (types) => types.reduce((h, type) => applySignal(h, { type }, 5), emptyHealth());

  it("blocked by the browser: click once", () => {
    const health = fold(["play-blocked"]);
    expect(healthStatus(health)).toMatchObject({ code: "play-blocked", level: "warn" });
    expect(healthMessage(health, 9).text).toBe(S.healthPlayBlocked);
    expect(S.healthPlayBlocked).toMatch(/click/i);
  });

  it("broken: the sound file could not play", () => {
    const health = fold(["play-failed"]);
    expect(healthStatus(health)).toMatchObject({ code: "play-failed", level: "warn" });
    expect(healthMessage(health, 9).text).toBe(S.healthPlayFailed);
    expect(S.healthPlayFailed).toMatch(/upload/i);
  });

  it("a sound that plays clears both", () => {
    expect(healthStatus(fold(["play-blocked", "play-failed", "played"])).code).toBe("waiting");
  });

  it("diagnostics count them separately", () => {
    const report = buildDiagnostics({ health: fold(["play-blocked", "play-failed"]), now: 9 });
    expect(report.counts).toMatchObject({ ourSoundBlockedInARow: 1, ourSoundFailedInARow: 1 });
  });
});

// ------------------------------------------------------------------ reading the chat list

describe("knowing (and saying) whether WhatsApp's chat list can be read", () => {
  const real = (name, unread = 0) =>
    `<div role="row"><div data-testid="cell-frame-container">` +
    `<div data-testid="cell-frame-title"><span dir="auto" title="${name}">${name}</span></div>` +
    `<div data-testid="cell-frame-secondary"><span title="hi">hi</span>` +
    (unread ? `<span data-testid="icon-unread-count">${unread}</span>` : "") +
    `</div></div></div>`;
  const renamed = (name, unread = 0) =>
    `<div class="r"><div><span dir="auto" title="${name}">${name}</span></div>` +
    `<div><span title="hi">hi</span>${unread ? `<span data-q="1">${unread}</span>` : ""}</div></div>`;
  const page = (html) => freshDocument(`<!DOCTYPE html><html><body>${html}</body></html>`);

  it("today's WhatsApp is read with WhatsApp's own names", () => {
    const model = createPageModel({
      document: page(`<div id="pane-side">${real("Radwa", 1)}${real("Mom")}</div>`),
    });
    model.readChats();
    expect(model.layers()).toEqual({ list: "builtin", name: "builtin", counter: "builtin" });
  });

  it("a renamed WhatsApp is read by structure", () => {
    const model = createPageModel({
      document: page(`<div class="l">${renamed("Radwa", 1)}${renamed("Mom")}</div>`),
      knownNames: () => ["Radwa", "Mom"],
    });
    model.readChats();
    expect(model.layers()).toEqual({ list: "structure", name: "structure", counter: "structure" });
  });

  it("what was learned is used first, and says so", () => {
    const doc = page(`<div class="l">${renamed("Radwa", 1)}${renamed("Mom", 2)}</div>`);
    const model = createPageModel({ document: doc, knownNames: () => ["Radwa", "Mom"] });
    model.learnFrom("Radwa");
    model.learnFrom("Mom");
    model.readChats();
    expect(model.layers()).toMatchObject({ name: "learned", counter: "learned" });
  });

  it("nothing readable says 'none'", () => {
    const model = createPageModel({ document: page("<div>loading</div>") });
    model.readChats();
    expect(model.layers()).toEqual({ list: "none", name: "none", counter: "none" });
  });

  it("the status line warns after three unreadable checks in a row, and clears", () => {
    const check = (readable) => ({ type: "page", readable, layers: { list: "none" } });
    let health = emptyHealth();
    for (let i = 0; i < 2; i++) health = applySignal(health, check(false), i);
    expect(healthStatus(health).code).toBe("waiting");
    health = applySignal(health, check(false), 3);
    expect(healthStatus(health)).toMatchObject({ code: "list-unreadable", level: "warn" });
    expect(healthMessage(health, 9).text).toBe(S.healthListUnreadable);
    expect(healthStatus(applySignal(health, check(true), 4)).code).toBe("waiting");
  });

  it("diagnostics say which way the list is being read, from a fixed vocabulary only", () => {
    const health = applySignal(
      emptyHealth(),
      {
        type: "page",
        readable: true,
        layers: { list: "structure", name: "learned", counter: "<script>" },
      },
      1
    );
    expect(buildDiagnostics({ health, now: 2 }).chatList).toEqual({
      readable: true,
      list: "structure",
      name: "learned",
      counter: "unknown",
    });
    expect(sanitizeHealth({ page: "junk" }).page).toEqual(emptyHealth().page);
  });

  it("the bridge passes such checks on to the status record", async () => {
    vi.useFakeTimers();
    const data = {
      settings: { enabled: true, volume: 1, defaultSoundId: null, showPopups: false },
      sounds: {},
      rules: [],
    };
    const doc = freshDocument();
    doc.addEventListener(EVENT_PING, () =>
      doc.dispatchEvent(
        new CustomEvent(EVENT_PONG, { detail: JSON.stringify({ notification: true, play: true }) })
      )
    );
    const bridge = startBridge({
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
      engine: { play: vi.fn(), invalidate: vi.fn(), canPlay: () => true },
      CustomEventCtor: CustomEvent,
    });
    await bridge.ready;
    bridge.report({ type: "page", readable: false, layers: { list: "none" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(data.health.page.unreadableRun).toBe(1);
    bridge.stop();
    vi.useRealTimers();
  });
});
