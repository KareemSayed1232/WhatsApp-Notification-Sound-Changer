import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { installMainHook } from "../../src/content/main-hook.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PLAY_NATIVE,
  KNOWN_INCOMING_SOUND_URL,
} from "../../src/core/protocol.mjs";

// The same behaviour on every browser while WhatsApp is focused (owner's requirement, Oct 2026).
// Measured: Edge's WhatsApp plays its own sound for a focused message (no notification, so no chat
// is known); Firefox's WhatsApp plays nothing. Either way the extension now finds the chat from its
// unread counter and plays: the chat's sound, else the default sound, else WhatsApp's own ding.

const RENAMED = "https://static.whatsapp.net/rsrc.php/zZ/r/NewDing.ogg";

// ------------------------------------------------------------------ the hook plays the ding

describe("the hook plays WhatsApp's own ding when asked", () => {
  let doc;
  let win;
  let hook;
  let played;
  let asks;
  let store;

  class FakeMedia {
    constructor(src) {
      this.src = src;
      this.currentSrc = src;
      this.isConnected = false;
    }
    play() {
      played.push(this.src);
      return Promise.resolve();
    }
  }

  function install() {
    hook = installMainHook({ window: win, document: doc });
  }

  beforeEach(() => {
    played = [];
    asks = [];
    store = {};
    doc = freshDocument();
    doc.addEventListener(EVENT_ASK, (e) => asks.push(JSON.parse(e.detail)));
    win = {
      Notification: class {
        static permission = "denied";
      },
      HTMLMediaElement: FakeMedia,
      Audio: FakeMedia,
      CustomEvent,
      localStorage: {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => (store[k] = String(v)),
      },
    };
    install();
  });
  afterEach(() => hook?.uninstall());

  const askForDing = () => doc.dispatchEvent(new CustomEvent(EVENT_PLAY_NATIVE));

  it("plays WhatsApp's known incoming sound, without our own hook stepping in", () => {
    askForDing();
    expect(played).toEqual([KNOWN_INCOMING_SOUND_URL]);
    expect(asks).toEqual([]); // it did not ask the bridge about its own ding
  });

  it("uses the sound WhatsApp itself last played, if WhatsApp renamed it", async () => {
    // WhatsApp plays its (renamed) sound after a notification: the hook remembers it.
    doc.addEventListener(EVENT_ASK, (e) => {
      if (JSON.parse(e.detail).kind === "notification") {
        doc.dispatchEvent(
          new CustomEvent(EVENT_ANSWER, {
            detail: JSON.stringify({ mode: "managed", decision: { action: "native" } }),
          })
        );
      }
    });
    // Twice: one time could be another WhatsApp sound (e.g. "message sent").
    for (let i = 0; i < 2; i++) {
      new win.Notification("Radwa", { tag: "1@lid", silent: true });
      await new FakeMedia(RENAMED).play();
    }
    played = [];
    askForDing();
    expect(played).toEqual([RENAMED]);
  });

  it("remembers that sound across a page reload", () => {
    store.wanscSoundUrl = RENAMED;
    hook.uninstall();
    install();
    askForDing();
    expect(played).toEqual([RENAMED]);
  });

  it("never plays something that is not a WhatsApp sound, even if storage was tampered with", () => {
    store.wanscSoundUrl = "https://evil.example.com/x.mp3";
    hook.uninstall();
    install();
    askForDing();
    expect(played).toEqual([KNOWN_INCOMING_SOUND_URL]);
  });

  it("does nothing (and does not throw) where the page has no Audio", () => {
    hook.uninstall();
    delete win.Audio;
    install();
    expect(() => askForDing()).not.toThrow();
    expect(played).toEqual([]);
  });

  it("stops listening once uninstalled", () => {
    hook.uninstall();
    askForDing();
    expect(played).toEqual([]);
  });
});

// ------------------------------------------------------------------ the bridge decides
