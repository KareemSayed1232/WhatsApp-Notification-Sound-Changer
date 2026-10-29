import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readUnreadCounts, scanChatList } from "../../src/content/chat-list.mjs";
import { createPageModel } from "../../src/content/page-model.mjs";
import { startUnreadWatcher } from "../../src/content/unread-watcher.mjs";

// Phase 5 of the fragility plan: a library of WhatsApp's REAL chat-list markup (captured Oct 2026)
// and variants of it that stand in for future WhatsApp updates. Every variant must still give
// the same chats, in the same order, with the same unread numbers, and no "Archived" or "Locked
// chats" entries. This proves that nothing important depends on today's names.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(path.resolve(here, "../fixtures/whatsapp-chat-list.html"), "utf8");

// The chat names the extension would already know (from notifications, rules, Refresh).
const KNOWN = () => ["Amaal", "Mohanad", "انا", "Family"];

const EXPECTED = { Amaal: 1, Mohanad: 0, انا: 14, Family: 0 };

const ARABIC_LABELS = {
  "Chat list": "قائمة الدردشات",
  "Locked chats": "الدردشات المقفلة",
  Archived: "المؤرشفة",
  "Muted chat": "دردشة مكتومة",
};

// ------------------------------------------------------------------ mutations

const each = (doc, selector, fn) => doc.querySelectorAll(selector).forEach(fn);
const removeAttr = (name) => (doc) => each(doc, `[${name}]`, (el) => el.removeAttribute(name));

const MUTATIONS = {
  "today's WhatsApp": () => {},
  "test ids removed": removeAttr("data-testid"),
  "roles removed": removeAttr("role"),
  "ids removed": removeAttr("id"),
  "labels removed": removeAttr("aria-label"),
  "everything renamed": (doc) => {
    each(doc, "[data-testid]", (el) => el.setAttribute("data-testid", `x-${el.dataset.testid}-v2`));
    each(doc, "[role]", (el) => el.setAttribute("role", `${el.getAttribute("role")}2`));
    each(doc, "[id]", (el) => (el.id = `${el.id}-v2`));
  },
  "labels in Arabic": (doc) =>
    each(doc, "[aria-label]", (el) => {
      const label = el.getAttribute("aria-label");
      const unread = /^(\d+) unread/.exec(label);
      el.setAttribute(
        "aria-label",
        unread ? `${unread[1]} رسائل غير مقروءة` : (ARABIC_LABELS[label] ?? label)
      );
    }),
  "rows wrapped deeper": (doc) =>
    each(doc, '[role="row"]', (row) => {
      const outer = doc.createElement("div");
      const inner = doc.createElement("div");
      row.replaceWith(outer);
      outer.append(inner);
      inner.append(row);
    }),
  "all of it at once": (doc) => {
    for (const name of ["data-testid", "role", "id", "aria-label"]) removeAttr(name)(doc);
  },
};

// Which variants keep SOME trace of the muted marker (a test id or a label mentioning a mute).
const MUTE_MARKER_SURVIVES = new Set([
  "today's WhatsApp",
  "test ids removed",
  "roles removed",
  "ids removed",
  "labels removed",
  "everything renamed",
  "labels in Arabic",
  "rows wrapped deeper",
]);

function page(mutation) {
  const doc = new globalThis.DOMParser().parseFromString(FIXTURE, "text/html");
  MUTATIONS[mutation](doc);
  return doc;
}

const counts = (chats) =>
  Object.fromEntries([...chats.values()].map((chat) => [chat.name, chat.count]));

// ------------------------------------------------------------------ the contract

describe.each(Object.keys(MUTATIONS))("WhatsApp's chat list: %s", (mutation) => {
  const model = () => createPageModel({ document: page(mutation), knownNames: KNOWN });

  it("reads the same chats, in the same order, with the same unread numbers", () => {
    expect(counts(model().readChats())).toEqual(EXPECTED);
    expect(model().readNames()).toEqual(Object.keys(EXPECTED));
  });

  it("never lists 'Archived' or 'Locked chats', and the open chat's header adds nothing", () => {
    const names = model().readNames();
    expect(names).not.toContain("Archived");
    expect(names).not.toContain("Locked chats");
    expect(names.filter((n) => n === "Amaal")).toHaveLength(1);
  });

  it("finds the chat list to watch", () => {
    expect(model().findPane()).not.toBeNull();
  });

  it(
    MUTE_MARKER_SURVIVES.has(mutation)
      ? "sees that Mohanad is muted"
      : "cannot see the mute (no trace left): the mutes learned from behaviour take over",
    () => {
      const chats = [...model().readChats().values()];
      expect(chats.find((c) => c.name === "Mohanad").muted).toBe(
        MUTE_MARKER_SURVIVES.has(mutation)
      );
      expect(chats.find((c) => c.name === "Amaal").muted).toBe(false);
    }
  );

  it("'Refresh chats' lists the same chats", async () => {
    const doc = page(mutation);
    const m = createPageModel({ document: doc, knownNames: KNOWN });
    const result = await scanChatList({
      document: doc,
      wait: async () => {},
      readNames: m.readNames,
      findPane: m.findPane,
    });
    expect(result).toEqual({ ok: true, names: Object.keys(EXPECTED) });
  });

  it("notices a new message while WhatsApp is focused", () => {
    const doc = page(mutation);
    const m = createPageModel({ document: doc, knownNames: KNOWN });
    const incoming = [];
    const observers = [];
    const watcher = startUnreadWatcher({
      document: doc,
      read: m.readChats,
      findPane: m.findPane,
      onIncoming: (name) => incoming.push(name),
      MutationObserverCtor: class {
        constructor(cb) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
      setTimeoutFn: (fn) => fn(),
      clearTimeoutFn: () => {},
      now: () => 100_000,
      isFocused: () => true,
    });
    // Family gets a message: its row grows an unread counter, shaped like Amaal's.
    const amaalCounter = [...doc.querySelectorAll("span")].find((s) => s.textContent === "1");
    const familyPreview = [...doc.querySelectorAll("span[title]")].find(
      (s) => s.getAttribute("title") === "Bob: hi"
    );
    familyPreview.parentElement.after(amaalCounter.cloneNode(true));
    observers.forEach((cb) => cb());
    expect(incoming).toEqual(["Family"]);
    watcher.stop();
  });
});

describe("with only part of the chats known (just two chats have notified so far)", () => {
  it.each(["all of it at once", "everything renamed"])("%s: still reads every chat", (mutation) => {
    const model = createPageModel({
      document: page(mutation),
      knownNames: () => ["Amaal", "Mohanad"],
    });
    expect(counts(model.readChats())).toEqual(EXPECTED);
  });
});

// A control: the contract above only means something if it fails without the self-teaching
// reader. WhatsApp's names of today alone (readUnreadCounts, the original reader) read nothing
// once those names change, which is exactly what the variants above survive.
describe("control: the original names-only reader on the same variants", () => {
  it.each(["all of it at once", "everything renamed"])(
    "%s: the names-only reader finds no chats at all",
    (mutation) => {
      expect(readUnreadCounts(page(mutation)).size).toBe(0);
    }
  );

  it("today's WhatsApp: both readers agree", () => {
    const doc = page("today's WhatsApp");
    expect(counts(readUnreadCounts(doc))).toEqual(EXPECTED);
  });
});
