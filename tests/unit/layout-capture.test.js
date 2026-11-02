import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshDocument } from "../helpers/load-script.js";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";
import { startChatWatcher } from "../../src/content/chat-watcher.mjs";
import { findChatPane, readChatNames } from "../../src/content/chat-list.mjs";
import { captureLayout } from "../../src/content/layout-capture.mjs";
import { MSG_LAYOUT } from "../../src/core/protocol.mjs";
import { createStateStore } from "../../src/core/state-store.mjs";
import { mountHealth } from "../../src/ui/health-ui.mjs";
import { STRINGS as S } from "../../src/ui/strings.mjs";

// Provided by the jsdom test environment (see vitest.config.js).
const { document } = globalThis;
// When WhatsApp redesigns its chat list, the fix starts from a copy of the new markup. "Copy page
// layout" gives the user one to attach to a report: the chat list's structure with every name,
// message and id replaced, still readable by the extension exactly like the real page.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(path.resolve(here, "../fixtures/whatsapp-chat-list.html"), "utf8");
// WhatsApp's own interface words, which are kept.
const UI_WORDS = /^(Archived|Locked chats|Photo|Chats|Chat list)$/;

const page = (html = FIXTURE) => freshDocument(html);
const chatsOf = (doc) => readChatNames(doc).map(() => true);
const capture = (doc) => captureLayout({ document: doc, findPane: () => findChatPane(doc) });

describe("capturing the chat list's layout", () => {
  it("keeps no chat names, message text or ids", () => {
    const doc = page();
    doc.querySelector('[role="row"]').setAttribute("data-id", "false_201001234567@c.us_3EB0A1");
    const html = capture(doc);
    const texts = [...page().querySelectorAll("[title]")].map((e) => e.title);
    const secrets = texts.filter((t) => !UI_WORDS.test(t) && !/^\d/.test(t));
    expect(secrets.length).toBeGreaterThan(2);
    for (const secret of secrets) expect(html).not.toContain(secret);
    expect(html).not.toMatch(/201001234567|@c\.us/);
  });

  it("is still read as the same chats, unread counts and mute markers", () => {
    const html = capture(page());
    const captured = page(`<!doctype html><html><body>${html}</body></html>`);
    expect(chatsOf(captured).length).toBeGreaterThan(0);
    expect(chatsOf(captured)).toEqual(chatsOf(page()));
  });

  it("keeps WhatsApp's own structure: roles, test ids, counters and times", () => {
    const html = capture(page());
    expect(html).toContain('role="row"');
    expect(html).toContain('data-testid="icon-unread-count"');
    expect(html).toContain("1 unread message");
    expect(html).toContain("12:30");
  });

  it("drops links and image addresses", () => {
    const doc = page();
    doc
      .querySelector('[role="row"]')
      .insertAdjacentHTML(
        "beforeend",
        '<img src="https://pps.whatsapp.net/v/t61/photo.jpg?oh=secret"><a href="https://x.test/p">x</a>'
      );
    expect(capture(doc)).not.toMatch(/pps\.whatsapp|oh=secret|x\.test/);
  });

  it("keeps only the first rows of a long list", () => {
    const rows = Array.from(
      { length: 60 },
      (_, i) => `<div role="row"><span dir="auto" title="P${i}">P${i}</span></div>`
    ).join("");
    const doc = page(`<!doctype html><html><body><div id="pane-side">${rows}</div></body></html>`);
    const html = captureLayout({ document: doc, findPane: () => doc.getElementById("pane-side") });
    expect(html.match(/role="row"/g)).toHaveLength(20);
  });

  it("returns null when there is no chat list", () => {
    expect(captureLayout({ document: freshDocument(), findPane: () => null })).toBeNull();
  });
});

describe("the WhatsApp tab answers a layout request", () => {
  function watcher(doc) {
    let listener = null;
    const chrome = {
      runtime: {
        id: "ext",
        sendMessage: vi.fn(),
        onMessage: { addListener: (fn) => (listener = fn), removeListener: () => {} },
      },
    };
    startChatWatcher({
      chrome,
      document: doc,
      findPane: () => findChatPane(doc),
      readNames: () => [],
      MutationObserverCtor: class {
        observe() {}
        disconnect() {}
      },
      setTimeoutFn: () => 0,
    });
    return (message, sender) =>
      new Promise((resolve) => {
        const async = listener(message, sender, resolve);
        if (!async) resolve(undefined);
      });
  }

  it("from the extension's own pages", async () => {
    const ask = watcher(page());
    const answer = await ask({ type: MSG_LAYOUT }, { id: "ext" });
    expect(answer.ok).toBe(true);
    expect(answer.html).toContain('role="row"');
  });

  it("never from anything else", async () => {
    const ask = watcher(page());
    expect(await ask({ type: MSG_LAYOUT }, { id: "someone-else" })).toBeUndefined();
  });
});

describe("Troubleshooting: Copy page layout", () => {
  let writeText;
  beforeEach(() => {
    writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  function mount(sendMessage, tabs = [{ id: 4, active: true }]) {
    const store = createStateStore({
      storage: createFakeStorage(),
      soundStore: createFakeSoundStore(),
    });
    const chrome = {
      runtime: { getManifest: () => ({ version: "3.0.0" }) },
      tabs: { query: vi.fn(async () => tabs), sendMessage: vi.fn(sendMessage) },
      storage: { onChanged: { addListener: () => {} } },
    };
    document.body.innerHTML = "";
    document.body.append(mountHealth({ document, stateStore: store, chrome, diagnostics: true }));
    return chrome;
  }

  it("copies the anonymised layout from the WhatsApp tab", async () => {
    const chrome = mount(async () => ({ ok: true, html: '<div role="row"></div>' }));
    document.querySelector("#copyLayout").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(4, { type: MSG_LAYOUT });
    expect(writeText.mock.calls[0][0]).toContain('<div role="row"></div>');
    expect(document.querySelector("#diagnosticsNote").textContent).toBe(S.layoutCopied);
  });

  it("says to open WhatsApp first when no tab is open", async () => {
    mount(async () => null, []);
    document.querySelector("#copyLayout").click();
    await vi.waitFor(() =>
      expect(document.querySelector("#diagnosticsNote").textContent).toBe(S.scanNoTab)
    );
    expect(writeText).not.toHaveBeenCalled();
  });
});
