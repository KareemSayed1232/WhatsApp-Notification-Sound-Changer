import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStateStore } from "../../src/core/state-store.mjs";
import { mountOptions } from "../../src/ui/options.mjs";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";

// Provided by the jsdom test environment (see vitest.config.js).
const { document } = globalThis;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const fire = (element, type) => element.dispatchEvent(new Event(type, { bubbles: true }));
const text = (selector) => $(selector)?.textContent ?? "";

const fakeFile = (name = "ping.mp3", type = "audio/mpeg") => ({
  name,
  type,
  size: 3,
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
});

let storage;
let soundStore;
let store;
let counter;
let changeListeners;
let player;
let confirmFn;

/** `setup(store)` runs before the page loads, to seed sounds/rules through the real store. */
async function mount({ initial = {}, setup } = {}) {
  storage = createFakeStorage(initial);
  soundStore = createFakeSoundStore();
  counter = 0;
  store = createStateStore({
    storage,
    soundStore,
    generateId: () => `id${++counter}`,
    now: () => 1,
  });
  if (setup) await setup(store);

  document.body.innerHTML = '<div id="app"></div>';
  changeListeners = [];
  player = { toggle: vi.fn(), stop: vi.fn() };
  confirmFn = vi.fn(() => true);
  await mountOptions({
    document,
    stateStore: store,
    soundStore,
    chrome: { storage: { onChanged: { addListener: (fn) => changeListeners.push(fn) } } },
    createPlayer: () => player,
    confirmFn,
  });
}

const seedSound =
  (name = "Ping") =>
  (s) =>
    s.addSound(fakeFile(`${name}.mp3`));

async function addViaForm({ name, kind = "chat", sound = "__default" }) {
  $("#ruleKind").value = kind;
  $("#ruleName").value = name;
  fire($("#ruleName"), "input");
  $("#ruleSound").value = sound;
  $("#addRuleForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

beforeEach(() => mount());

describe("first run", () => {
  it("shows friendly empty states and a disabled default-sound picker", () => {
    expect(text("#rulesEmpty")).toMatch(/No chats yet/);
    expect($("#soundsEmpty").hidden).toBe(false);
    expect($("#defaultSound").disabled).toBe(true);
    expect($("#recent").disabled).toBe(true);
    expect($("#enabled").checked).toBe(true);
    expect($("#showPopups").checked).toBe(false);
  });

  it("labels every control so it is usable with a screen reader", () => {
    for (const id of ["recent", "ruleKind", "ruleName", "ruleSound", "defaultSound", "volume"]) {
      expect(document.querySelector(`label[for="${id}"]`), `label for #${id}`).not.toBeNull();
    }
    expect($("#message").getAttribute("aria-live")).toBe("polite");
  });
});

describe("settings", () => {
  it("saves the on/off switch", async () => {
    $("#enabled").checked = false;
    fire($("#enabled"), "change");
    await vi.waitFor(async () => expect((await store.load()).settings.enabled).toBe(false));
  });

  it("saves the popup preference", async () => {
    $("#showPopups").checked = true;
    fire($("#showPopups"), "change");
    await vi.waitFor(async () => expect((await store.load()).settings.showPopups).toBe(true));
  });

  it("saves the volume and shows it as a percentage", async () => {
    $("#volume").value = "0.3";
    fire($("#volume"), "input");
    expect(text(".volume-out")).toBe("30%");
    fire($("#volume"), "change");
    await vi.waitFor(async () => expect((await store.load()).settings.volume).toBe(0.3));
  });
});

describe("sounds", () => {
  const upload = async (...files) => {
    Object.defineProperty($("#soundFile"), "files", { value: files, configurable: true });
    fire($("#soundFile"), "change");
  };

  it("adds an uploaded sound and makes the first one the default", async () => {
    await upload(fakeFile("ping.mp3"));
    await vi.waitFor(() => expect($$("#soundList li")).toHaveLength(1));
    const state = await store.load();
    expect(state.settings.defaultSoundId).toBe(Object.keys(state.sounds)[0]);
    expect(text("#message")).toMatch(/Added "ping.mp3"/);
    expect($(".badge").textContent).toBe("Default");
    expect($("#defaultSound").disabled).toBe(false);
  });

  it("keeps the existing default when more sounds are added", async () => {
    await upload(fakeFile("a.mp3"));
    await vi.waitFor(() => expect($$("#soundList li")).toHaveLength(1));
    const first = (await store.load()).settings.defaultSoundId;
    await upload(fakeFile("b.mp3"), fakeFile("c.mp3"));
    await vi.waitFor(() => expect($$("#soundList li")).toHaveLength(3));
    expect((await store.load()).settings.defaultSoundId).toBe(first);
  });

  it("rejects an unsupported file with a clear message and stores nothing", async () => {
    await upload(fakeFile("notes.txt", "text/plain"));
    await vi.waitFor(() => expect(text("#message")).toMatch(/isn't supported/));
    expect($("#message").className).toContain("toast-error");
    expect(Object.keys((await store.load()).sounds)).toEqual([]);
  });

  it("changes the default sound, including back to none", async () => {
    await mount({
      setup: async (s) => {
        await seedSound("A")(s);
        await seedSound("B")(s);
      },
    });
    const [first, second] = Object.keys((await store.load()).sounds);
    $("#defaultSound").value = second;
    fire($("#defaultSound"), "change");
    await vi.waitFor(async () => expect((await store.load()).settings.defaultSoundId).toBe(second));
    $("#defaultSound").value = "";
    fire($("#defaultSound"), "change");
    await vi.waitFor(async () => expect((await store.load()).settings.defaultSoundId).toBeNull());
    expect(first).toBeTruthy();
  });

  it("previews a sound", async () => {
    await mount({ setup: seedSound() });
    $(".preview").click();
    expect(player.toggle).toHaveBeenCalledWith("id1");
  });

  it("makes a non-default sound the default", async () => {
    await mount({
      setup: async (s) => {
        await seedSound("A")(s);
        await seedSound("B")(s);
        await s.setSettings({ defaultSoundId: "id1" });
      },
    });
    $('[data-sound-id="id2"] .make-default').click();
    await vi.waitFor(async () => expect((await store.load()).settings.defaultSoundId).toBe("id2"));
  });

  it("asks before deleting, and keeps the sound if you cancel", async () => {
    await mount({
      setup: async (s) => {
        const sound = await seedSound()(s);
        await s.setSettings({ defaultSoundId: sound.id });
      },
    });
    confirmFn.mockReturnValue(false);
    $(".delete-sound").click();
    await new Promise((r) => setTimeout(r, 10));
    expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining("Chats using it will go back"));
    expect(Object.keys((await store.load()).sounds)).toHaveLength(1);
  });

  it("deletes a sound and returns the chats that used it to the default", async () => {
    await mount({
      setup: async (s) => {
        const sound = await seedSound()(s);
        await s.addRule({ kind: "chat", match: "Alice", action: "sound", soundId: sound.id });
      },
    });
    $(".delete-sound").click();
    await vi.waitFor(() => expect($$("#soundList li")).toHaveLength(0));
    const state = await store.load();
    expect(state.rules[0]).toMatchObject({ action: "default", soundId: null });
    expect($(".rule-sound").value).toBe("__default");
    expect(text("#message")).toMatch(/Deleted/);
  });
});

describe("chat rules", () => {
  it("adds a rule by typing a name", async () => {
    await mount({ setup: seedSound() });
    await addViaForm({ name: "  Mom ", sound: "id1" });
    await vi.waitFor(() => expect($$("#rulesBody tr")).toHaveLength(1));
    expect((await store.load()).rules[0]).toMatchObject({
      kind: "chat",
      match: "Mom",
      action: "sound",
      soundId: "id1",
      chatId: null,
    });
    expect($("#ruleName").value).toBe("");
    expect(text(".cell-name .name")).toBe("Mom");
  });

  it("adds a person-in-a-group rule", async () => {
    await addViaForm({ name: "Bob", kind: "sender", sound: "__silent" });
    await vi.waitFor(() => expect($$("#rulesBody tr")).toHaveLength(1));
    expect((await store.load()).rules[0]).toMatchObject({ kind: "sender", action: "silent" });
    expect(text(".cell-name .meta")).toBe("Person in a group");
  });

  it("picks a recent chat, binds it to its chat id, and removes it from the recent list", async () => {
    await mount({
      initial: { recentSenders: [{ name: "Radwa", kind: "chat", chatId: "601@lid", lastSeen: 1 }] },
    });
    expect($("#recent").disabled).toBe(false);
    $("#recent").value = "chat|601@lid";
    fire($("#recent"), "change");
    expect($("#ruleName").value).toBe("Radwa");

    $("#ruleSound").value = "__silent";
    $("#addRuleForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect($$("#rulesBody tr")).toHaveLength(1));

    expect((await store.load()).rules[0]).toMatchObject({
      match: "Radwa",
      chatId: "601@lid",
      action: "silent",
    });
    expect($$("#recent option").map((o) => o.value)).toEqual([""]);
    expect($(".linked")).not.toBeNull();
  });

  it("forgets the picked chat id when the name is edited by hand", async () => {
    await mount({
      initial: { recentSenders: [{ name: "Radwa", kind: "chat", chatId: "601@lid", lastSeen: 1 }] },
    });
    $("#recent").value = "chat|601@lid";
    fire($("#recent"), "change");
    $("#ruleName").value = "Somebody else";
    fire($("#ruleName"), "input");
    $("#addRuleForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect($$("#rulesBody tr")).toHaveLength(1));
    expect((await store.load()).rules[0].chatId).toBeNull();
  });

  it("explains a duplicate instead of failing silently", async () => {
    await mount({ setup: (s) => s.addRule({ kind: "chat", match: "Alice", action: "silent" }) });
    await addViaForm({ name: "alice" });
    await vi.waitFor(() => expect(text("#message")).toMatch(/already have a rule/));
    expect($("#message").className).toContain("toast-error");
    expect($$("#rulesBody tr")).toHaveLength(1);
  });

  it("refuses an empty name", async () => {
    await addViaForm({ name: "   " });
    await vi.waitFor(() => expect(text("#message")).toMatch(/Enter a name/));
  });

  describe("with existing rules", () => {
    beforeEach(() =>
      mount({
        setup: async (s) => {
          await seedSound()(s);
          await s.addRule({ kind: "chat", match: "Alice", action: "default" });
          await s.addRule({ kind: "chat", match: "Bob", action: "default" });
        },
      })
    );

    it("changes the sound for one chat only", async () => {
      const alice = $$("#rulesBody tr").find((tr) => tr.textContent.includes("Alice"));
      alice.querySelector(".rule-sound").value = "id1";
      fire(alice.querySelector(".rule-sound"), "change");
      await vi.waitFor(async () => {
        const rules = (await store.load()).rules;
        expect(rules.find((r) => r.match === "Alice")).toMatchObject({
          action: "sound",
          soundId: "id1",
        });
        expect(rules.find((r) => r.match === "Bob").action).toBe("default");
      });
    });

    it("switches a rule off and on", async () => {
      const row = $("#rulesBody tr");
      const toggle = row.querySelector("input[type=checkbox]");
      toggle.checked = false;
      fire(toggle, "change");
      expect(row.classList.contains("is-off")).toBe(true);
      await vi.waitFor(async () =>
        expect((await store.load()).rules.find((r) => r.match === "Alice").enabled).toBe(false)
      );
    });

    it("deletes a rule", async () => {
      $("#rulesBody tr .delete-rule").click();
      await vi.waitFor(() => expect($$("#rulesBody tr")).toHaveLength(1));
      expect((await store.load()).rules.map((r) => r.match)).toEqual(["Bob"]);
    });

    it("filters the list as you type", () => {
      $("#search").value = "bo";
      fire($("#search"), "input");
      expect($$("#rulesBody tr")).toHaveLength(1);
      expect(text("#rulesBody .name")).toBe("Bob");

      $("#search").value = "zzz";
      fire($("#search"), "input");
      expect($("#rulesEmpty").hidden).toBe(false);
      expect(text("#rulesEmpty")).toMatch(/Nothing matches/);
    });
  });
});

describe("security and live updates", () => {
  it("shows contact names as plain text, never as HTML", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    await mount({ setup: (s) => s.addRule({ kind: "chat", match: evil, action: "silent" }) });
    expect($("#rulesBody img")).toBeNull();
    expect(text("#rulesBody .name")).toBe(evil);
  });

  it("offers newly seen chats without reloading the page", async () => {
    expect($("#recent").disabled).toBe(true);
    storage.data.recentSenders = [{ name: "Newcomer", kind: "chat", chatId: "7@lid", lastSeen: 5 }];
    changeListeners.forEach((fn) => fn({ recentSenders: {} }, "local"));
    await vi.waitFor(() =>
      expect($$("#recent option").map((o) => o.textContent)).toContain("Newcomer (Chat)")
    );
    expect($("#recent").disabled).toBe(false);
  });

  it("ignores storage changes that are not about recent chats", () => {
    const before = storage.calls.get;
    changeListeners.forEach((fn) => fn({ rules: {} }, "local"));
    changeListeners.forEach((fn) => fn({ recentSenders: {} }, "sync"));
    expect(storage.calls.get).toBe(before);
  });
});
