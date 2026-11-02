import { describe, it, expect, vi } from "vitest";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";
import { createStateStore } from "../../src/core/state-store.mjs";
import { mountOptions } from "../../src/ui/options.mjs";
import { mountPopup } from "../../src/ui/popup.mjs";
import { STRINGS as S } from "../../src/ui/strings.mjs";

// WhatsApp's page carries no chat ids, so a chat picked by name (Refresh chat list) is tied to
// its chat id the first time it notifies. Each chat with its own sound shows which it is:
// "Linked" (matched by the chat's id, safe) or "Waiting for first message" (still by name).

// Provided by the jsdom test environment (see vitest.config.js).
const { document, window } = globalThis;

const sound = {
  name: "Ping.mp3",
  type: "audio/mpeg",
  size: 3,
  arrayBuffer: async () => new Uint8Array(3).buffer,
};
const recentSenders = [
  { name: "Radwa", kind: "chat", chatId: "601@lid", lastSeen: 3 },
  { name: "Mom", kind: "chat", lastSeen: 2 },
];

async function makeStore() {
  let n = 0;
  const store = createStateStore({
    storage: createFakeStorage({ recentSenders, knownChats: [{ name: "Mom" }] }),
    soundStore: createFakeSoundStore(),
    generateId: () => `id${++n}`,
    now: () => 1,
  });
  const { id } = await store.addSound(sound);
  await store.addRule({
    kind: "chat",
    match: "Radwa",
    chatId: "601@lid",
    action: "sound",
    soundId: id,
  });
  await store.addRule({ kind: "chat", match: "Mom", chatId: null, action: "sound", soundId: id });
  return store;
}

const chrome = () => ({
  tabs: { query: vi.fn(async () => []), sendMessage: vi.fn(), update: vi.fn() },
  windows: { create: vi.fn(), update: vi.fn() },
  runtime: {
    openOptionsPage: vi.fn(),
    getURL: (p) => p,
    getManifest: () => ({ version: "3.0.0" }),
  },
  storage: { onChanged: { addListener: () => {} } },
});

const statusOf = (name) =>
  [...document.querySelectorAll("li")]
    .find((li) => li.querySelector(".name")?.textContent === name)
    ?.querySelector(".link-status")?.textContent ?? null;

describe("the popup shows whether each chat sound is tied to its chat", () => {
  it("Linked for a chat tied to its id, Waiting for one still matched by name", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.spyOn(window, "close").mockImplementation(() => {});
    await mountPopup({
      document,
      stateStore: await makeStore(),
      chrome: chrome(),
      useUploadWindow: false,
    });
    expect(statusOf("Radwa")).toBe(S.linked);
    expect(statusOf("Mom")).toBe(S.waitingLink);
  });
});

describe("the settings page shows it too", () => {
  it("on each chat with its own sound", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await mountOptions({
      document,
      stateStore: await makeStore(),
      soundStore: createFakeSoundStore(),
      chrome: chrome(),
    });
    expect(statusOf("Radwa")).toBe(S.linked);
    expect(statusOf("Mom")).toBe(S.waitingLink);
  });
});

describe("the wording", () => {
  it("is plain", () => {
    expect(S.linked).toBe("Linked ✓");
    expect(S.waitingLink).toBe("Waiting for first message");
  });
});
