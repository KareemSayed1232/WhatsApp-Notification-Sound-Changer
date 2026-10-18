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

const fakeSound = (name) => ({
  name,
  type: "audio/mpeg",
  size: 3,
  arrayBuffer: async () => new Uint8Array(3).buffer,
});

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
    tabs: {
      query: vi.fn(async () => [{ id: 5, active: true }]),
      sendMessage: vi.fn(async () => ({ ok: true, count: 0 })),
    },
    runtime: { openOptionsPage: vi.fn() },
    storage: { onChanged: { addListener: (fn) => changeListeners.push(fn) } },
  };
  await mountPopup({ document, stateStore: store, chrome });
}

const twoSounds = async (s) => {
  await s.addSound(fakeSound("Ping.mp3")); // id1
  await s.addSound(fakeSound("Chime.mp3")); // id2
};

const rowOf = (name) =>
  $$("#chatList li").find((li) => li.querySelector(".name").textContent === name);
const selectOf = (name) => rowOf(name).querySelector("select");
const choose = (name, value) => {
  const select = selectOf(name);
  select.value = value;
  fire(select, "change");
};
const submitQuickAdd = () =>
  $("#quickAdd").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

beforeEach(() => {
  vi.spyOn(window, "close").mockImplementation(() => {});
  return mount({ initial: { recentSenders }, setup: twoSounds });
});

describe("the chat list", () => {
  it("shows the chats that messaged you, each with its own sound dropdown", () => {
    expect($$("#chatList .name").map((n) => n.textContent)).toEqual(["Radwa", "Family"]);
    expect(rowOf("Family").textContent).toContain("Group");
    expect([...selectOf("Radwa").options].map((o) => o.textContent)).toEqual([
      "Default sound",
      "Silent (no sound)",
      "Chime.mp3",
      "Ping.mp3",
      "＋ Upload new sound…",
    ]);
    expect($("#chatsEmpty").hidden).toBe(true);
  });

  it("sets a chat's sound with one change, bound to its chat id", async () => {
    choose("Radwa", "id1");
    await vi.waitFor(async () => expect((await store.load()).rules).toHaveLength(1));
    expect((await store.load()).rules[0]).toMatchObject({
      match: "Radwa",
      chatId: "601@lid",
      action: "sound",
      soundId: "id1",
    });
    await vi.waitFor(() => expect(rowOf("Radwa").classList.contains("is-set")).toBe(true));
    expect(selectOf("Radwa").value).toBe("id1");
  });

  it("can silence a chat, and return it to the default", async () => {
    choose("Family", "__silent");
    await vi.waitFor(async () =>
      expect((await store.load()).rules[0]).toMatchObject({ action: "silent" })
    );
    choose("Family", "__default");
    await vi.waitFor(async () => expect((await store.load()).rules).toEqual([]));
    expect(rowOf("Family")).toBeTruthy();
  });

  it("sends 'Upload new sound' to the settings page (a popup closes when a file dialog opens)", () => {
    choose("Radwa", "__upload");
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    expect(selectOf("Radwa").value).toBe("__default"); // the dropdown is put back
  });

  it("shows an empty state when nothing has messaged you yet", async () => {
    await mount({ setup: twoSounds });
    expect($("#chatsEmpty").hidden).toBe(false);
    expect($$("#chatList li")).toHaveLength(0);
  });

  it("shows names as plain text, never as HTML", async () => {
    await mount({
      initial: {
        recentSenders: [
          { name: "<b onmouseover=x>hi</b>", kind: "chat", chatId: "1@lid", lastSeen: 1 },
        ],
      },
      setup: twoSounds,
    });
    expect($("#chatList b")).toBeNull();
    expect($("#chatList .name").textContent).toBe("<b onmouseover=x>hi</b>");
  });

  it("adds chats that arrive while it is open, but not under an open dropdown", async () => {
    const arrive = () => {
      storage.data.recentSenders = [
        { name: "Late", kind: "chat", chatId: "9@lid", lastSeen: 9 },
        ...recentSenders,
      ];
      changeListeners.forEach((fn) => fn({ recentSenders: {} }, "local"));
    };
    const select = selectOf("Radwa");
    select.focus();
    arrive();
    await new Promise((r) => setTimeout(r, 20));
    expect(rowOf("Late")).toBeUndefined();
    fire(select, "focusout");
    await vi.waitFor(() => expect(rowOf("Late")).toBeTruthy());
  });
});

describe("loading every chat from WhatsApp", () => {
  it("shows chats read from WhatsApp's chat list, one row per name", async () => {
    await mount({
      initial: { recentSenders, knownChats: [{ name: "Mom" }, { name: "radwa" }] },
      setup: twoSounds,
    });
    expect($$("#chatList .name").map((n) => n.textContent)).toEqual(["Radwa", "Family", "Mom"]);
  });

  it("reads the chat list from the WhatsApp tab when you press Refresh", async () => {
    chrome.tabs.sendMessage.mockImplementation(async () => {
      storage.data.knownChats = [{ name: "Fresh Chat" }];
      return { ok: true, count: 1 };
    });
    $("#refreshChats").click();
    await vi.waitFor(() => expect(rowOf("Fresh Chat")).toBeTruthy());
    expect($("#message").textContent).toBe("Found 1 chat.");
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(5, { type: "wansc:scan-chats" });
  });

  it("explains when WhatsApp Web is not open", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    $("#refreshChats").click();
    await vi.waitFor(() => expect($("#message").textContent).toMatch(/Open WhatsApp Web/));
  });

  it("describes adding by name as the last resort", () => {
    expect($(".add-by-name summary").textContent).toMatch(/Last resort/);
  });

  it("keeps people inside groups out of the popup's list", async () => {
    await mount({
      initial: { recentSenders: [{ name: "Bob", kind: "sender", lastSeen: 5 }, ...recentSenders] },
      setup: twoSounds,
    });
    expect($$("#chatList .name").map((n) => n.textContent)).toEqual(["Radwa", "Family"]);
  });
});

describe("default sound, volume and the on/off switch", () => {
  it("shows the default sound with an explanation, and lets you change it", async () => {
    expect($$("#defaultSound option").map((o) => o.textContent)).toEqual([
      "None (keep WhatsApp's own sound)",
      "Chime.mp3",
      "Ping.mp3",
    ]);
    expect($("#defaultHint").textContent).toMatch(/WhatsApp's normal sound/);
    $("#defaultSound").value = "id2";
    fire($("#defaultSound"), "change");
    await vi.waitFor(async () => expect((await store.load()).settings.defaultSoundId).toBe("id2"));
    expect($("#defaultHint").textContent).toMatch(/no sound of its own/);
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

  it("shows saved settings when opened", async () => {
    await mount({
      setup: async (s) => {
        await s.setSettings({ enabled: false, volume: 0.4 });
      },
    });
    expect($("#enabled").checked).toBe(false);
    expect($("#volume").value).toBe("0.4");
    expect($(".volume-out").textContent).toBe("40%");
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
});

describe("adding a chat by name", () => {
  it("adds a chat that has not messaged you", async () => {
    $("#quickName").value = "  Mom ";
    $("#quickSound").value = "id2";
    submitQuickAdd();
    await vi.waitFor(() => expect(rowOf("Mom")).toBeTruthy());
    expect((await store.load()).rules[0]).toMatchObject({
      match: "Mom",
      chatId: null,
      soundId: "id2",
    });
    expect($("#quickName").value).toBe("");
    expect($("#message").textContent).toMatch(/Added "Mom"/);
  });

  it("recognises a recent chat by name, so it is bound to the chat id and not listed twice", async () => {
    $("#quickName").value = "radwa";
    $("#quickSound").value = "__silent";
    submitQuickAdd();
    await vi.waitFor(async () => expect((await store.load()).rules).toHaveLength(1));
    expect((await store.load()).rules[0].chatId).toBe("601@lid");
    expect($$("#chatList li")).toHaveLength(2);
  });

  it("explains a duplicate and keeps what you typed; refuses an empty name", async () => {
    await store.addRule({ kind: "chat", match: "Mom", action: "silent" });
    $("#quickName").value = "mom";
    submitQuickAdd();
    await vi.waitFor(() => expect($("#message").textContent).toMatch(/already have a rule/));
    expect($("#quickName").value).toBe("mom");

    $("#quickName").value = "   ";
    submitQuickAdd();
    await vi.waitFor(() => expect($("#message").textContent).toMatch(/Enter a name/));
  });
});
