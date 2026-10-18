import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStateStore } from "../../src/core/state-store.mjs";
import { mountUpload } from "../../src/ui/upload.mjs";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";

// Provided by the jsdom test environment (see vitest.config.js).
const { document, window } = globalThis;

const $ = (selector) => document.querySelector(selector);
const fire = (element, type) => element.dispatchEvent(new Event(type, { bubbles: true }));

const recentSenders = [{ name: "Radwa", kind: "chat", chatId: "601@lid", lastSeen: 3 }];

const fakeFile = (name = "meow.mp3", type = "audio/mpeg") => ({
  name,
  type,
  size: 3,
  arrayBuffer: async () => new Uint8Array(3).buffer,
});

let storage;
let store;
let closed;

async function open(chat, { initial = { recentSenders }, setup } = {}) {
  storage = createFakeStorage(initial);
  let counter = 0;
  store = createStateStore({
    storage,
    soundStore: createFakeSoundStore(),
    generateId: () => `id${++counter}`,
    now: () => 1,
  });
  if (setup) await setup(store);
  document.body.innerHTML = '<div id="app"></div>';
  await mountUpload({
    document,
    stateStore: store,
    search: chat === undefined ? "" : `?chat=${encodeURIComponent(chat)}`,
    closeAfterMs: 0,
  });
}

const chooseFile = (file) => {
  Object.defineProperty($("#soundFile"), "files", { value: [file], configurable: true });
  fire($("#soundFile"), "change");
};

beforeEach(() => {
  closed = vi.spyOn(window, "close").mockImplementation(() => {});
});

describe("the upload window", () => {
  it("names the chat it is for, with a big, clearly worded button", async () => {
    await open("chat|radwa");
    expect($("#uploadName").textContent).toBe("Radwa");
    expect($("#chooseFile").textContent).toContain("Choose a sound file");
    expect($("#soundFile").accept).toBe("audio/*");
  });

  it("shows the chat name as plain text, never as HTML", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    await open('chat|<img src=x onerror="alert(1)">', {
      initial: { recentSenders: [{ name: evil, kind: "chat", chatId: "1@lid", lastSeen: 1 }] },
    });
    expect($("#app img")).toBeNull();
    expect($("#uploadName").textContent).toBe(evil);
  });

  it("explains itself when the chat is missing from the URL or the list", async () => {
    await open(undefined);
    expect($("#noChat").textContent).toMatch(/isn't in your list/);
    expect($("#chooseFile")).toBeNull();

    await open("chat|nobody");
    expect($("#noChat")).not.toBeNull();
  });

  it("uploads the file, gives it to the chat (bound to its chat id), then closes itself", async () => {
    await open("chat|radwa");
    chooseFile(fakeFile("meow.mp3"));

    await vi.waitFor(async () => expect((await store.load()).rules).toHaveLength(1));
    const state = await store.load();
    const meow = Object.values(state.sounds).find((s) => s.name === "meow.mp3");
    expect(meow).toBeTruthy();
    expect(state.rules[0]).toMatchObject({
      kind: "chat",
      match: "Radwa",
      chatId: "601@lid",
      action: "sound",
      soundId: meow.id,
    });
    expect($("#status").textContent).toBe('Added "meow.mp3" for Radwa. This window will close.');
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
  });

  it("says 'Uploading…' the moment the file arrives", async () => {
    await open("chat|radwa");
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    chooseFile({
      ...fakeFile("slow.mp3"),
      arrayBuffer: async () => {
        await gate;
        return new Uint8Array(3).buffer;
      },
    });
    await vi.waitFor(() => expect($("#status").textContent).toBe('Uploading "slow.mp3"…'));
    release();
    await vi.waitFor(() => expect($("#status").textContent).toMatch(/^Added "slow.mp3"/));
  });

  it("shows a clear error for an unsupported file, changes nothing, and stays open", async () => {
    await open("chat|radwa");
    chooseFile(fakeFile("notes.txt", "text/plain"));
    await vi.waitFor(() => expect($("#status").textContent).toMatch(/isn't supported/));
    expect($("#status").className).toContain("toast-error");
    expect((await store.load()).rules).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).not.toHaveBeenCalled();
  });

  it("works for a chat read from WhatsApp's list (no chat id), as a name rule", async () => {
    await open("chat|mom", { initial: { knownChats: [{ name: "Mom" }] } });
    chooseFile(fakeFile("ping.mp3"));
    await vi.waitFor(async () => expect((await store.load()).rules).toHaveLength(1));
    expect((await store.load()).rules[0]).toMatchObject({ match: "Mom", chatId: null });
  });

  it("updates the existing rule when the chat already has a sound", async () => {
    await open("chat|radwa", {
      setup: async (s) => {
        await s.addSound(fakeFile("old.mp3")); // id1
        await s.addRule({
          kind: "chat",
          match: "Radwa",
          chatId: "601@lid",
          action: "sound",
          soundId: "id1",
        });
      },
    });
    chooseFile(fakeFile("new.mp3"));
    await vi.waitFor(async () => {
      const { rules, sounds } = await store.load();
      expect(rules).toHaveLength(1);
      expect(sounds[rules[0].soundId].name).toBe("new.mp3");
    });
  });

  it("works for a person inside a group", async () => {
    await open("sender|bob", {
      initial: { recentSenders: [{ name: "Bob", kind: "sender", lastSeen: 1 }] },
    });
    chooseFile(fakeFile("hey.mp3"));
    await vi.waitFor(async () =>
      expect((await store.load()).rules[0]).toMatchObject({ kind: "sender", match: "Bob" })
    );
  });

  it("ignores a cancelled picker (no file)", async () => {
    await open("chat|radwa");
    Object.defineProperty($("#soundFile"), "files", { value: [], configurable: true });
    fire($("#soundFile"), "change");
    await new Promise((r) => setTimeout(r, 20));
    expect($("#status").hidden).toBe(true);
    expect((await store.load()).rules).toEqual([]);
  });
});
