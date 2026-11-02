import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshDocument } from "../helpers/load-script.js";
import { readChatNames } from "../../src/content/chat-list.mjs";
import { installMainHook } from "../../src/content/main-hook.mjs";
import {
  EVENT_ANSWER,
  EVENT_ASK,
  WHATSAPP_MATCH,
  WHATSAPP_ORIGIN,
} from "../../src/core/protocol.mjs";

// Phase B of the "what if WhatsApp changes" plan: never silent by accident, and tolerance for
// small changes in WhatsApp's markup and text.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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
