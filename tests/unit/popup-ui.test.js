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

const withTwoSounds = async (s) => {
  await withSound(s);
  await s.addSound({
    name: "Chime.mp3",
    type: "audio/mpeg",
    size: 3,
    arrayBuffer: async () => new Uint8Array(3).buffer,
  });
};

const submitQuickAdd = () =>
  $("#quickAdd").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

describe("configuring chats from the popup", () => {
  beforeEach(() => mount({ initial: { recentSenders }, setup: withTwoSounds }));

  it("shows the default sound and lets you change it", async () => {
    expect($$("#defaultSound option").map((o) => o.textContent)).toEqual([
      "None (keep WhatsApp's own sound)",
      "Chime.mp3", // same upload time, so alphabetical
      "Ping.mp3",
    ]);
    $("#defaultSound").value = "id2";
    fire($("#defaultSound"), "change");
    await vi.waitFor(async () => expect((await store.load()).settings.defaultSoundId).toBe("id2"));
  });

  it("explains what no default sound means, and updates when one is picked", async () => {
    expect($("#defaultHint").textContent).toMatch(/WhatsApp's normal sound/);
    $("#defaultSound").value = "id1";
    fire($("#defaultSound"), "change");
    await vi.waitFor(() => expect($("#defaultHint").textContent).toMatch(/no sound of its own/));
  });

  it("starts with an empty chat list", () => {
    expect($("#rulesEmpty").hidden).toBe(false);
    expect($$("#rulesList li")).toHaveLength(0);
  });

  it("adds a chat by typing its name and choosing a sound", async () => {
    $("#quickName").value = "  Mom ";
    $("#quickSound").value = "id2";
    submitQuickAdd();
    await vi.waitFor(() => expect($$("#rulesList li")).toHaveLength(1));

    expect((await store.load()).rules[0]).toMatchObject({
      kind: "chat",
      match: "Mom",
      chatId: null,
      action: "sound",
      soundId: "id2",
    });
    expect($("#quickName").value).toBe("");
    expect($("#rulesList .name").textContent).toBe("Mom");
    expect($("#message").textContent).toMatch(/Added "Mom"/);
    expect($("#rulesEmpty").hidden).toBe(true);
  });

  it("binds the rule to the chat id when the typed name matches a recent chat", async () => {
    $("#quickName").value = "radwa"; // any capitalisation
    $("#quickSound").value = "__silent";
    submitQuickAdd();
    await vi.waitFor(() => expect($$("#rulesList li")).toHaveLength(1));
    expect((await store.load()).rules[0]).toMatchObject({
      match: "radwa",
      chatId: "601@lid",
      action: "silent",
    });
  });

  it("offers the recent chats as suggestions while typing", () => {
    expect($$("#quickRecents option").map((o) => o.value)).toEqual(["Radwa", "Family"]);
  });

  it("explains a duplicate and keeps what you typed", async () => {
    await store.addRule({ kind: "chat", match: "Mom", action: "silent" });
    $("#quickName").value = "mom";
    submitQuickAdd();
    await vi.waitFor(() => expect($("#message").textContent).toMatch(/already have a rule/));
    expect($("#message").className).toContain("toast-error");
    expect($("#quickName").value).toBe("mom");
  });

  it("refuses an empty name", async () => {
    $("#quickName").value = "   ";
    submitQuickAdd();
    await vi.waitFor(() => expect($("#message").textContent).toMatch(/Enter a name/));
  });

  describe("with chats already configured", () => {
    beforeEach(async () => {
      await store.addRule({ kind: "chat", match: "Mom", action: "default" });
      await store.addRule({ kind: "chat", match: "Boss", action: "silent" });
      await mount({ initial: storage.data });
    });

    it("lists every chat with its current sound", () => {
      expect($$("#rulesList li .name").map((n) => n.textContent)).toEqual(["Boss", "Mom"]);
      expect($$("#rulesList select")[0].value).toBe("__silent");
      expect($$("#rulesList select")[1].value).toBe("__default");
    });

    it("changes the sound for one chat", async () => {
      const mom = $$("#rulesList li").find((li) => li.textContent.includes("Mom"));
      mom.querySelector("select").value = "id1";
      fire(mom.querySelector("select"), "change");
      await vi.waitFor(async () => {
        const rules = (await store.load()).rules;
        expect(rules.find((r) => r.match === "Mom")).toMatchObject({
          action: "sound",
          soundId: "id1",
        });
        expect(rules.find((r) => r.match === "Boss").action).toBe("silent");
      });
    });

    it("deletes a chat", async () => {
      const boss = $$("#rulesList li").find((li) => li.textContent.includes("Boss"));
      boss.querySelector(".delete-rule").click();
      await vi.waitFor(() => expect($$("#rulesList li")).toHaveLength(1));
      expect((await store.load()).rules.map((r) => r.match)).toEqual(["Mom"]);
    });
  });
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
