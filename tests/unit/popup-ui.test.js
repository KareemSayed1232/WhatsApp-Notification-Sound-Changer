import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStateStore } from "../../src/core/state-store.mjs";
import { mountPopup } from "../../src/ui/popup.mjs";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";

// Provided by the jsdom test environment (see vitest.config.js).
const { document, window } = globalThis;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const fire = (element, type) => element.dispatchEvent(new Event(type, { bubbles: true }));

let storage;
let store;
let chrome;
let changeListeners;

const recentSenders = [
  { name: "Radwa", kind: "chat", chatId: "601@lid", lastSeen: 3 },
  { name: "Family", kind: "chat", chatId: "120@g.us", lastSeen: 2 },
];

async function mount({ initial = {}, setup } = {}) {
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
  changeListeners = [];
  chrome = {
    runtime: { openOptionsPage: vi.fn() },
    storage: { onChanged: { addListener: (fn) => changeListeners.push(fn) } },
  };
  await mountPopup({ document, stateStore: store, chrome });
}

const withSound = (s) =>
  s.addSound({
    name: "Ping.mp3",
    type: "audio/mpeg",
    size: 3,
    arrayBuffer: async () => new Uint8Array(3).buffer,
  });

beforeEach(() => {
  vi.spyOn(window, "close").mockImplementation(() => {});
  return mount({ initial: { recentSenders }, setup: withSound });
});

describe("popup", () => {
  it("shows the on/off switch and volume from saved settings", async () => {
    await mount({
      setup: async (s) => {
        await s.setSettings({ enabled: false, volume: 0.4 });
      },
    });
    expect($("#enabled").checked).toBe(false);
    expect($("#volume").value).toBe("0.4");
    expect($(".volume-out").textContent).toBe("40%");
  });

  it("saves the on/off switch and the volume", async () => {
    $("#enabled").checked = false;
    fire($("#enabled"), "change");
    $("#volume").value = "0.2";
    fire($("#volume"), "change");
    await vi.waitFor(async () => {
      const { settings } = await store.load();
      expect(settings).toMatchObject({ enabled: false, volume: 0.2 });
    });
  });

  it("lists recent chats with a sound picker each", () => {
    expect($$("#recentList li")).toHaveLength(2);
    expect($("#recentEmpty").hidden).toBe(true);
    const labels = $$("#recentList .name").map((n) => n.textContent);
    expect(labels).toEqual(["Radwa", "Family"]);
    expect($$("#recentList li")[1].textContent).toContain("Group");
  });

  it("assigns a sound to a recent chat in one tap, bound to its chat id", async () => {
    const select = $('#recentList [data-key="chat|601@lid"] select');
    select.value = "id1";
    fire(select, "change");
    await vi.waitFor(async () => expect((await store.load()).rules).toHaveLength(1));
    expect((await store.load()).rules[0]).toMatchObject({
      match: "Radwa",
      chatId: "601@lid",
      action: "sound",
      soundId: "id1",
    });
    expect($$("#recentList li")).toHaveLength(1); // it now has a rule, so it leaves the list
  });

  it("can silence a chat in one tap", async () => {
    const select = $('#recentList [data-key="chat|120@g.us"] select');
    select.value = "__silent";
    fire(select, "change");
    await vi.waitFor(async () =>
      expect((await store.load()).rules[0]).toMatchObject({ action: "silent" })
    );
  });

  it("ignores the placeholder option", async () => {
    const select = $("#recentList select");
    select.value = "";
    fire(select, "change");
    await new Promise((r) => setTimeout(r, 10));
    expect((await store.load()).rules).toEqual([]);
  });

  it("shows an empty state when nothing has messaged you yet", async () => {
    await mount({ setup: withSound });
    expect($("#recentEmpty").hidden).toBe(false);
    expect($$("#recentList li")).toHaveLength(0);
  });

  it("points a new user at settings when there are no sounds yet", async () => {
    await mount({ initial: { recentSenders } });
    expect($("#needSound").hidden).toBe(false);
  });

  it("hides that hint once a sound exists", () => {
    expect($("#needSound").hidden).toBe(true);
  });

  it("opens the full settings page", () => {
    $("#openSettings").click();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it("adds chats that arrive while it is open", async () => {
    await mount({ setup: withSound });
    storage.data.recentSenders = [{ name: "Late", kind: "chat", chatId: "9@lid", lastSeen: 9 }];
    changeListeners.forEach((fn) => fn({ recentSenders: {} }, "local"));
    await vi.waitFor(() => expect($$("#recentList li")).toHaveLength(1));
  });

  it("shows names as plain text, never as HTML", async () => {
    await mount({
      initial: {
        recentSenders: [
          { name: "<b onmouseover=x>hi</b>", kind: "chat", chatId: "1@lid", lastSeen: 1 },
        ],
      },
      setup: withSound,
    });
    expect($("#recentList b")).toBeNull();
    expect($("#recentList .name").textContent).toBe("<b onmouseover=x>hi</b>");
  });
});
