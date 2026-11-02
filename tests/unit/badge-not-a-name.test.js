import { describe, it, expect } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";
import { readChatNames } from "../../src/content/chat-list.mjs";
import { looksLikeChatName } from "../../src/core/normalize.mjs";
import { createStateStore } from "../../src/core/state-store.mjs";

// Owner's log (Edge, focused):
//   new message in 8 unread messages while focused -> {action: 'native'}
//   new message in 8 while focused -> {action: 'native'}
// The chat list's unread badge was read as the chat's NAME, so no rule matched and WhatsApp's
// own sound played instead of the custom one. Once such a "name" is remembered it is used to find
// names on the page again, so the mistake fed itself. A badge, a count or a time is never a name.

describe("what can be a chat name", () => {
  it("rejects counters, unread labels and times", () => {
    for (const bad of [
      "8",
      "123",
      "8 unread messages",
      "1 unread message",
      "12:30",
      "9:05 PM",
      "",
    ]) {
      expect(looksLikeChatName(bad)).toBe(false);
    }
  });

  it("accepts real names, including ones with numbers in them", () => {
    for (const good of ["Radwa", "Family 2024", "Team 7", "أمي", "+20 100 123 4567", "Mom ❤️"]) {
      expect(looksLikeChatName(good)).toBe(true);
    }
  });
});

describe("the chat list never reads the unread badge as the name", () => {
  it("the plain name reader too (Refresh chat list)", () => {
    const doc = freshDocument(
      `<!DOCTYPE html><html><body><div id="pane-side">` +
        `<div role="row"><span dir="auto" title="8 unread messages">8 unread messages</span></div>` +
        `<div role="row"><span dir="auto" title="Radwa">Radwa</span></div>` +
        `</div></body></html>`
    );
    expect(readChatNames(doc)).toEqual(["Radwa"]);
  });
});

describe("a badge remembered as a chat by mistake is forgotten", () => {
  it("is not stored, and one already stored is ignored", async () => {
    const storage = createFakeStorage({
      knownChats: [{ name: "8 unread messages" }, { name: "Mom" }],
    });
    const store = createStateStore({ storage, soundStore: createFakeSoundStore() });
    expect((await store.load()).knownChats.map((c) => c.name)).toEqual(["Mom"]);
    await store.recordChats(["8", "Radwa", "12:30"]);
    expect((await store.load()).knownChats.map((c) => c.name)).toEqual(["Radwa", "Mom"]);
  });
});
