import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withPageSounds } from "../helpers/page-sounds.js";
import { freshDocument } from "../helpers/load-script.js";
import { installMainHook } from "../../src/content/main-hook.mjs";
import { EVENT_ANSWER, EVENT_ASK, EVENT_PLAY } from "../../src/core/protocol.mjs";

// WhatsApp plays its message sound a moment after the notification (measured: a few ms to ~0.5 s).
// If an update makes it much slower than the pairing window (up to 2 s), the sound used to lose
// its chat: it got the default sound, or a second sound after ours. A WhatsApp sound up to 3 s
// after a notification that no sound has claimed yet now still belongs to that notification.

const KNOWN = "https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3";
const RENAMED = "https://static.whatsapp.net/rsrc.php/zZ/r/NewHash123.mp3";
const CHAT = { action: "play", soundId: "chat", volume: 1 };
const DEFAULT = { action: "play", soundId: "default", volume: 1 };

class FakeNotification {
  static permission = "denied";
}
class FakeMedia {
  static nativePlays = [];
  constructor(src, { connected = false } = {}) {
    this.src = src;
    this.currentSrc = src;
    this.isConnected = connected;
  }
  play() {
    FakeMedia.nativePlays.push(this.src);
    return Promise.resolve();
  }
}

let doc;
let win;
let hook;
let plays;

beforeEach(() => {
  vi.useFakeTimers();
  FakeMedia.nativePlays = [];
  doc = freshDocument();
  win = {
    Notification: FakeNotification,
    HTMLMediaElement: FakeMedia,
    CustomEvent,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
  doc.addEventListener(EVENT_ASK, (event) => {
    const q = JSON.parse(event.detail);
    const answer =
      q.kind === "notification"
        ? { mode: "managed", decision: CHAT }
        : q.kind === "default-sound"
          ? { decision: DEFAULT }
          : null;
    if (answer)
      doc.dispatchEvent(new CustomEvent(EVENT_ANSWER, { detail: JSON.stringify(answer) }));
  });
  plays = [];
  doc.addEventListener(EVENT_PLAY, (event) => plays.push(JSON.parse(event.detail).soundId));
  hook = installMainHook({ window: win, document: doc, now: () => Date.now() });
  withPageSounds(win, doc);
});

afterEach(() => {
  hook.uninstall();
  vi.useRealTimers();
});

const notify = (options = {}) =>
  new win.Notification("Radwa", { tag: "601@lid", silent: true, ...options });
const whatsappPlays = (src) => new win.HTMLMediaElement(src).play();

describe("a WhatsApp sound arriving late", () => {
  it("still gets the chat's sound, not the default, 2.5 s after the notification", async () => {
    notify();
    await vi.advanceTimersByTimeAsync(2_500);
    await whatsappPlays(KNOWN);
    expect(plays).toEqual(["chat"]);
    expect(FakeMedia.nativePlays).toEqual([]);
  });

  it("but not an unknown WhatsApp sound (it may be another one, such as 'message sent')", async () => {
    notify();
    await vi.advanceTimersByTimeAsync(2_500);
    await whatsappPlays(RENAMED);
    expect(plays).toEqual([]);
    expect(FakeMedia.nativePlays).toEqual([RENAMED]);
  });

  it("is silenced if we already played the chat's sound ourselves", async () => {
    notify({ silent: false }); // the OS would have rung: we play the chat's sound after ~1 s
    await vi.advanceTimersByTimeAsync(2_500);
    expect(plays).toEqual(["chat"]);
    await whatsappPlays(KNOWN);
    expect(plays).toEqual(["chat"]); // no second sound
    expect(FakeMedia.nativePlays).toEqual([]);
  });

  it("belongs to one notification only: a second late sound is a new message", async () => {
    notify();
    await vi.advanceTimersByTimeAsync(2_500);
    await whatsappPlays(KNOWN);
    await vi.advanceTimersByTimeAsync(200);
    await whatsappPlays(KNOWN);
    expect(plays).toEqual(["chat", "default"]);
  });

  it("long after any notification, it is treated as a sound with no notification (as before)", async () => {
    notify();
    await vi.advanceTimersByTimeAsync(10_000);
    await whatsappPlays(KNOWN);
    expect(plays).toEqual(["default"]);
  });

  it("an unrecognised sound long after a notification is left alone (as before)", async () => {
    notify();
    await vi.advanceTimersByTimeAsync(10_000);
    await whatsappPlays(RENAMED);
    expect(plays).toEqual([]);
    expect(FakeMedia.nativePlays).toEqual([RENAMED]);
  });

  it("never touches media inside the page (voice messages, videos)", async () => {
    notify();
    await vi.advanceTimersByTimeAsync(2_500);
    await new win.HTMLMediaElement("blob:https://web.whatsapp.com/voice", {
      connected: true,
    }).play();
    expect(plays).toEqual([]);
  });
});
