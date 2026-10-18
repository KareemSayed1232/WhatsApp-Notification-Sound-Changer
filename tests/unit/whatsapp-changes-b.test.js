import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshDocument } from "../helpers/load-script.js";
import { createAudioEngine } from "../../src/content/audio-engine.mjs";
import { startBridge } from "../../src/content/bridge.mjs";
import { readChatNames } from "../../src/content/chat-list.mjs";
import { installMainHook } from "../../src/content/main-hook.mjs";
import { applySignal, emptyHealth, healthStatus } from "../../src/core/health.mjs";
import { parseSenderFromBody } from "../../src/core/matcher.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  EVENT_PING,
  EVENT_PLAY,
  EVENT_PONG,
  MSG_SEEN,
  WHATSAPP_MATCH,
  WHATSAPP_ORIGIN,
} from "../../src/core/protocol.mjs";
import { healthMessage } from "../../src/ui/health-ui.mjs";
import { STRINGS as S } from "../../src/ui/strings.mjs";

// Phase B of the "what if WhatsApp changes" plan: never silent by accident, and tolerance for
// small changes in WhatsApp's markup and text.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sounds = { s1: { id: "s1", name: "Ping", mime: "audio/mpeg", size: 3 } };
const settings = { enabled: true, volume: 1, defaultSoundId: "s1", showPopups: false };
const radwaRule = {
  id: "r1",
  kind: "chat",
  match: "Radwa",
  chatId: "601@lid",
  action: "sound",
  soundId: "s1",
  enabled: true,
};

// ------------------------------------------------------------------ a bridge with fakes

function createBridgeHarness() {
  const h = { data: null, chrome: null, bridge: null, doc: null };

  h.boot = async (engine, { rules = [radwaRule] } = {}) => {
    h.data = { settings, sounds, rules };
    h.doc = freshDocument();
    // Stand in for an installed page hook, so the status is not "hook missing".
    h.doc.addEventListener(EVENT_PING, () =>
      h.doc.dispatchEvent(
        new CustomEvent(EVENT_PONG, { detail: JSON.stringify({ notification: true, play: true }) })
      )
    );
    h.chrome = {
      storage: {
        local: {
          get: vi.fn(async (keys) =>
            Object.fromEntries(keys.filter((k) => k in h.data).map((k) => [k, h.data[k]]))
          ),
          set: vi.fn(async (items) => Object.assign(h.data, items)),
        },
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
      runtime: { id: "ext", sendMessage: vi.fn(async () => ({ ok: true })) },
    };
    h.bridge = startBridge({
      chrome: h.chrome,
      document: h.doc,
      engine,
      CustomEventCtor: CustomEvent,
    });
    await h.bridge.ready;
  };

  h.ask = (payload) => {
    let answer = null;
    const onAnswer = (event) => (answer = JSON.parse(event.detail));
    h.doc.addEventListener(EVENT_ANSWER, onAnswer);
    h.doc.dispatchEvent(new CustomEvent(EVENT_ASK, { detail: JSON.stringify(payload) }));
    h.doc.removeEventListener(EVENT_ANSWER, onAnswer);
    return answer;
  };

  h.requestPlay = (soundId = "s1") =>
    h.doc.dispatchEvent(
      new CustomEvent(EVENT_PLAY, { detail: JSON.stringify({ soundId, volume: 1 }) })
    );

  h.flush = () => vi.advanceTimersByTimeAsync(1_000);
  return h;
}

const notification = (extra = {}) => ({
  kind: "notification",
  title: "Radwa",
  tag: "601@lid",
  body: "hi",
  ...extra,
});

// ------------------------------------------------------------------ B5

describe("B5: never silent by accident when our sound cannot play", () => {
  describe("the audio engine says whether it can play right now", () => {
    let created;
    class FakeContext {
      static state = "running";
      constructor() {
        this.state = FakeContext.state;
        this.resume = vi.fn(async () => {});
        created.push(this);
      }
    }
    const engineWith = (Ctor) => createAudioEngine({ AudioContextCtor: Ctor, loadSound: vi.fn() });

    beforeEach(() => {
      created = [];
    });

    it("yes, when audio is running", () => {
      FakeContext.state = "running";
      expect(engineWith(FakeContext).canPlay()).toBe(true);
    });

    it("no, while the browser keeps audio suspended, and it asks to resume for next time", () => {
      FakeContext.state = "suspended";
      const engine = engineWith(FakeContext);
      expect(engine.canPlay()).toBe(false);
      expect(engine.canPlay()).toBe(false);
      expect(created).toHaveLength(1); // the same context is reused
      expect(created[0].resume).toHaveBeenCalled();
    });

    it("no, when audio cannot be created at all", () => {
      const Broken = function Broken() {
        throw new Error("no audio");
      };
      expect(engineWith(Broken).canPlay()).toBe(false);
    });
  });

  describe("the bridge", () => {
    const h = createBridgeHarness();
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      h.bridge?.stop();
      vi.useRealTimers();
    });

    const engine = (canPlay, played = true) => ({
      canPlay: vi.fn(() => canPlay),
      play: vi.fn(async () => played),
      invalidate: vi.fn(),
    });

    it("lets WhatsApp's own sound through when our sound could not start", async () => {
      await h.boot(engine(false));
      expect(h.ask(notification()).decision).toEqual({ action: "native" });
    });

    it("does the same for the default sound when the tab is focused", async () => {
      await h.boot(engine(false));
      expect(h.ask({ kind: "default-sound" }).decision).toEqual({ action: "native" });
    });

    it("plays our sound as usual when it can", async () => {
      await h.boot(engine(true));
      expect(h.ask(notification()).decision).toMatchObject({ action: "play", soundId: "s1" });
    });

    it("leaves a silent rule silent even when audio is blocked", async () => {
      const silentRule = { ...radwaRule, action: "silent", soundId: null };
      await h.boot(engine(false), { rules: [silentRule] });
      expect(h.ask(notification()).decision).toMatchObject({ action: "silent" });
    });

    it("works with an engine that cannot tell (an older engine): plays as usual", async () => {
      await h.boot({ play: vi.fn(async () => true), invalidate: vi.fn() });
      expect(h.ask(notification()).decision).toMatchObject({ action: "play" });
    });

    it("tells the status line when it had to fall back", async () => {
      await h.boot(engine(false));
      h.ask(notification());
      await h.flush();
      expect(healthStatus(h.data.health).code).toBe("play-failed");
    });

    it("tells the status line when our sound failed after WhatsApp's was already muted", async () => {
      await h.boot(engine(true, false));
      h.requestPlay();
      await h.flush();
      expect(healthStatus(h.data.health).code).toBe("play-failed");
    });

    it("clears it once a sound plays again", async () => {
      await h.boot(engine(true, true));
      h.data.health = applySignal(emptyHealth(), { type: "play-failed" }, 1);
      h.requestPlay();
      await h.flush();
      expect(healthStatus(h.data.health).code).not.toBe("play-failed");
    });
  });

  describe("the status line", () => {
    it("explains what to do", () => {
      const health = applySignal(emptyHealth(), { type: "play-blocked" }, 1);
      expect(healthStatus(health)).toMatchObject({ code: "play-failed", level: "warn" });
      expect(healthMessage(health, 2)).toEqual({ level: "warn", text: S.healthPlayFailed });
      expect(S.healthPlayFailed).toMatch(/click/i);
    });

    it("is cleared by a sound that played", () => {
      let health = applySignal(emptyHealth(), { type: "play-failed" }, 1);
      health = applySignal(health, { type: "played" }, 2);
      expect(healthStatus(health).code).not.toBe("play-failed");
    });

    it("ranks below a missing hook", () => {
      let health = applySignal(emptyHealth(), { type: "play-failed" }, 1);
      health = applySignal(health, { type: "hook", state: "missing" }, 2);
      expect(healthStatus(health).code).toBe("hook-missing");
    });
  });
});

// ------------------------------------------------------------------ B6

describe("B6: the hidden notification behaves like a real one", () => {
  let doc;
  let win;
  let hook;

  class FakeNotification {
    static permission = "denied";
  }

  beforeEach(() => {
    doc = freshDocument();
    win = { Notification: FakeNotification, HTMLMediaElement: class {}, CustomEvent };
    hook = installMainHook({ window: win, document: doc });
    doc.addEventListener(EVENT_ASK, () =>
      doc.dispatchEvent(
        new CustomEvent(EVENT_ANSWER, {
          detail: JSON.stringify({ mode: "managed", decision: { action: "native" } }),
        })
      )
    );
  });

  afterEach(() => hook.uninstall());

  const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("fires 'show' shortly after it is created, like the browser does", async () => {
    const stub = new win.Notification("Radwa", { tag: "601@lid", silent: true });
    const onshow = vi.fn();
    const listener = vi.fn();
    stub.onshow = onshow;
    stub.addEventListener("show", listener);
    expect(onshow).not.toHaveBeenCalled(); // never synchronously
    await nextTick();
    expect(onshow).toHaveBeenCalledTimes(1);
    expect(onshow.mock.calls[0][0]).toMatchObject({ type: "show", target: stub });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not call a listener that was removed", async () => {
    const stub = new win.Notification("Radwa", { silent: true });
    const listener = vi.fn();
    stub.addEventListener("show", listener);
    stub.removeEventListener("show", listener);
    await nextTick();
    expect(listener).not.toHaveBeenCalled();
  });

  it("fires 'close' once when the page closes it", () => {
    const stub = new win.Notification("Radwa", { silent: true });
    const onclose = vi.fn();
    const listener = vi.fn();
    stub.onclose = onclose;
    stub.addEventListener("close", listener);
    stub.close();
    stub.close();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a throwing handler never breaks the page or the other handlers", async () => {
    const stub = new win.Notification("Radwa", { silent: true });
    const after = vi.fn();
    stub.onshow = () => {
      throw new Error("page bug");
    };
    stub.addEventListener("show", after);
    await nextTick();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("can still dispatch events by hand", () => {
    const stub = new win.Notification("Radwa", { silent: true });
    const listener = vi.fn();
    stub.addEventListener("click", listener);
    expect(stub.dispatchEvent({ type: "click" })).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------ B7

describe("B7: non-chat rows are recognised in any language", () => {
  const chatRow = (name) =>
    `<div role="row"><div role="gridcell"><div data-testid="cell-frame-container">` +
    `<div data-testid="cell-frame-title"><span dir="auto" title="${name}">${name}</span></div>` +
    `<div data-testid="cell-frame-secondary"><span dir="auto" title="hi">hi</span></div>` +
    `</div></div></div>`;
  // The "Archived" / "Locked chats" entries: a plain button, not a row (captured Oct 2026).
  const pseudoRow = (label) =>
    `<button aria-label="${label}" type="button">` +
    `<div data-testid="cell-frame-container"><div data-testid="cell-frame-title">` +
    `<span dir="auto" title="${label}">${label}</span></div></div></button>`;
  const page = (html) =>
    freshDocument(
      `<!DOCTYPE html><html><body><div id="pane-side"><div role="grid">${html}</div></div></body></html>`
    );

  it("skips the Archived and Locked chats entries in Arabic", () => {
    const doc = page(pseudoRow("المؤرشفة") + pseudoRow("الدردشات المقفلة") + chatRow("انا"));
    expect(readChatNames(doc)).toEqual(["انا"]);
  });

  it("skips them in any other language too", () => {
    const doc = page(pseudoRow("Archivados") + pseudoRow("Gesperrte Chats") + chatRow("Mom"));
    expect(readChatNames(doc)).toEqual(["Mom"]);
  });

  it("keeps a real chat whose name happens to contain 'Archived'", () => {
    const doc = page(chatRow("Archived photos") + chatRow("Locked chats club"));
    expect(readChatNames(doc)).toEqual(["Archived photos", "Locked chats club"]);
  });

  it("keeps a real chat row even if WhatsApp wraps it in a button", () => {
    const doc = page(
      `<div role="row"><button type="button"><div data-testid="cell-frame-container">` +
        `<div data-testid="cell-frame-title"><span dir="auto" title="Dad">Dad</span></div>` +
        `</div></button></div>`
    );
    expect(readChatNames(doc)).toEqual(["Dad"]);
  });
});

// ------------------------------------------------------------------ B8

describe("B8: small changes in how WhatsApp writes the group sender", () => {
  it.each([
    [" Bob‎: hi", "Bob‎"],
    ["Bob: hi", "Bob"],
    ["Bob: hi", "Bob"], // no-break space after the colon
    ["Bob: hi", "Bob"], // narrow no-break space
    ["Bob : hi", "Bob"], // French-style space before the colon
    ["Bob：hi", "Bob"], // full-width colon
    ["Bob： hi", "Bob"],
  ])("%j -> %j", (body, sender) => {
    expect(parseSenderFromBody(body)).toBe(sender);
  });

  it.each(["no colon here", "12:30 meeting", "see https://example.com", ": starts with colon", ""])(
    "still finds no sender in %j",
    (body) => {
      expect(parseSenderFromBody(body)).toBeNull();
    }
  );

  describe("which notifications the sender is collected from", () => {
    const h = createBridgeHarness();
    afterEach(() => h.bridge?.stop());

    const seenItems = () =>
      h.chrome.runtime.sendMessage.mock.calls
        .filter(([m]) => m.type === MSG_SEEN)
        .flatMap(([m]) => m.items);

    const boot = () => h.boot({ play: vi.fn(), invalidate: vi.fn(), canPlay: () => true });

    it("groups, as today", async () => {
      await boot();
      h.ask(notification({ title: "Family", tag: "120@g.us", body: "Bob: hi" }));
      expect(seenItems()).toContainEqual({ name: "Bob", kind: "sender" });
    });

    it("a chat id of a kind we do not know yet (WhatsApp changed its group ids)", async () => {
      await boot();
      h.ask(notification({ title: "Family", tag: "120@groups.new", body: "Bob: hi" }));
      expect(seenItems()).toContainEqual({ name: "Bob", kind: "sender" });
    });

    it("but never one-to-one chats, where 'Note: ...' is just a message", async () => {
      await boot();
      h.ask(notification({ title: "Radwa", tag: "601@lid", body: "Note: buy milk" }));
      h.ask(notification({ title: "Mom", tag: "201@c.us", body: "Note: buy milk" }));
      expect(seenItems().filter((i) => i.kind === "sender")).toEqual([]);
    });

    it("and not when the 'sender' is just the chat's own name", async () => {
      await boot();
      h.ask(notification({ title: "Family", tag: "120@groups.new", body: "Family: hi" }));
      expect(seenItems().filter((i) => i.kind === "sender")).toEqual([]);
    });
  });
});

// ------------------------------------------------------------------ B9

describe("B9: WhatsApp's address lives in one place", () => {
  it("is defined once in the protocol", () => {
    expect(WHATSAPP_ORIGIN).toBe("https://web.whatsapp.com");
    expect(WHATSAPP_MATCH).toBe(`${WHATSAPP_ORIGIN}/*`);
  });

  it("and the manifest asks for exactly that address everywhere", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "src/manifest.json"), "utf8"));
    expect(manifest.host_permissions).toEqual([WHATSAPP_MATCH]);
    for (const script of manifest.content_scripts) expect(script.matches).toEqual([WHATSAPP_MATCH]);
  });

  it("is not written out anywhere else in the extension's code", () => {
    const files = [
      "src/background/background.mjs",
      "src/ui/chat-actions.mjs",
      "src/content/bridge.mjs",
      "src/ui/popup.mjs",
      "src/ui/options.mjs",
    ];
    for (const file of files) {
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toContain("web.whatsapp.com");
    }
  });
});
