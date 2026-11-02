import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withPageSounds } from "../helpers/page-sounds.js";
import { freshDocument } from "../helpers/load-script.js";
import { installMainHook } from "../../src/content/main-hook.mjs";
import { EVENT_ANSWER, EVENT_ASK, EVENT_PLAY } from "../../src/core/protocol.mjs";

// The unread badge read as a chat's name showed a whole class of weakness: the extension GUESSES
// what something on WhatsApp's page is, and some guesses are SAVED and reused, so one wrong guess
// keeps repeating. Every guess that is saved now needs evidence first, and every guess about the
// page refuses look-alikes.

// ------------------------------------------------------------------ learned sound files

describe("a WhatsApp sound is learned as 'the incoming sound' only with evidence", () => {
  const SENT = "https://static.whatsapp.net/rsrc.php/x/MessageSent.mp3"; // e.g. WhatsApp's sent sound
  let doc;
  let win;
  let hook;
  let store;
  let natives;
  let plays;
  let t;

  beforeEach(() => {
    t = 100_000;
    store = {};
    natives = [];
    plays = [];
    doc = freshDocument();
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
    doc.addEventListener(EVENT_PLAY, (e) => plays.push(JSON.parse(e.detail).soundId));
    doc.addEventListener(EVENT_ASK, (e) => {
      const q = JSON.parse(e.detail);
      const answer =
        q.kind === "notification"
          ? { mode: "managed", decision: { action: "play", soundId: "chat", volume: 1 } }
          : q.kind === "default-sound"
            ? { decision: { action: "play", soundId: "default", volume: 1 } }
            : null;
      if (answer) {
        doc.dispatchEvent(new CustomEvent(EVENT_ANSWER, { detail: JSON.stringify(answer) }));
      }
    });
    hook = installMainHook({ window: win, document: doc, now: () => t });
    withPageSounds(win, doc);
  });
  afterEach(() => hook.uninstall());

  const play = (src) => new win.HTMLMediaElement(src).play();
  const notifyThen = async (src, delay = 100) => {
    new win.Notification("Radwa", { tag: "601@lid", silent: true });
    t += delay;
    await play(src);
    t += 60_000;
  };

  it("the owner replies fast once: WhatsApp's sent sound is NOT learned as incoming", async () => {
    await notifyThen(SENT); // the sent sound happened to follow a notification
    plays.length = 0;
    natives.length = 0;
    await play(SENT); // later, the owner sends a message
    expect(plays).toEqual([]); // no default sound rings for sending
    expect(natives).toEqual([SENT]);
  });

  it("a sound that follows notifications twice is learned", async () => {
    await notifyThen(SENT);
    await notifyThen(SENT);
    plays.length = 0;
    await play(SENT);
    expect(plays).toEqual(["default"]);
  });

  it("forgets files learned by the old one-time rule", async () => {
    hook.uninstall();
    store.wanscLearnedSounds = JSON.stringify(["MessageSent.mp3"]);
    hook = installMainHook({ window: win, document: doc, now: () => t });
    withPageSounds(win, doc);
    await play(SENT);
    expect(plays).toEqual([]);
    expect(natives).toEqual([SENT]);
  });
});

// ------------------------------------------------------------------ moving a rule to a new id

// ------------------------------------------------------------------ the mute icon

// ------------------------------------------------------------------ names from known names
