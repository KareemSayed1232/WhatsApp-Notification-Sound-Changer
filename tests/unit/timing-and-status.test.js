import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withPageSounds } from "../helpers/page-sounds.js";
import { freshDocument } from "../helpers/load-script.js";
import { installMainHook } from "../../src/content/main-hook.mjs";
import {
  applySignal,
  buildDiagnostics,
  emptyHealth,
  healthStatus,
} from "../../src/core/health.mjs";
import { EVENT_ANSWER, EVENT_ASK, EVENT_PLAY, EVENT_SIGNAL } from "../../src/core/protocol.mjs";
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
    withPageSounds(win, doc);
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

  // Since 3.0 a known WhatsApp sound up to 3 s after an unclaimed notification still gets that
  // chat's sound (late-sounds.test.js), so a slow WhatsApp no longer loses the chat. The window
  // still decides how long to wait before playing on our own, and is still measured and kept.

  it("starts with today's half-second window, and a later sound still gets the chat's sound", async () => {
    await message(20); // WhatsApp measured 2-26 ms (Oct 2026)
    expect(plays).toHaveLength(1);
    await message(600);
    expect(plays).toHaveLength(2);
    expect(natives).toEqual([]);
  });

  it("measures WhatsApp's sound arriving late", async () => {
    await message(800);
    expect(plays).toHaveLength(1);
    expect(JSON.parse(store.wanscTiming)).toContain(800);
  });

  it("does not learn from a different WhatsApp sound (e.g. 'message sent')", async () => {
    await message(800, OTHER);
    expect(plays).toHaveLength(0);
    expect(natives).toEqual([OTHER]); // left alone
    expect(store.wanscTiming).toBeUndefined();
    expect(store.wanscLearnedSounds ?? "[]").not.toContain("sent-tick");
  });

  it("gives up on a notification after 3 s", async () => {
    await message(4_000);
    expect(plays).toHaveLength(0);
    await message(2_500);
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
    await message(20);
    expect(JSON.parse(store.wanscTiming)).toEqual([800, 20]);

    store.wanscTiming = '["x", -5, 99999]';
    hook.uninstall();
    install();
    await message(20);
    expect(JSON.parse(store.wanscTiming)).toEqual([20]); // nonsense dropped
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
