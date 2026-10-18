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

const recentSenders = [
  { name: "Radwa", kind: "chat", chatId: "601@lid", lastSeen: 3 },
  { name: "Family", kind: "chat", chatId: "120@g.us", lastSeen: 2 },
];

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

const twoSounds = async (s) => {
  await s.addSound(fakeFile("Ping.mp3")); // id1
  await s.addSound(fakeFile("Chime.mp3")); // id2
};

const rowOf = (name) =>
  $$("#chatList li").find((li) => li.querySelector(".name").textContent === name);
const selectOf = (name) => rowOf(name).querySelector("select");
const choose = (name, value) => {
  const select = selectOf(name);
  select.value = value;
  fire(select, "change");
};
const submitAddByName = () =>
  $("#addRuleForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const pickFile = (...files) => {
  Object.defineProperty($("#assignFile"), "files", { value: files, configurable: true });
};

beforeEach(() => mount());

describe("first run", () => {
  it("explains that chats show up once they message you, and has a way to add one by name", () => {
    expect($("#chatsEmpty").hidden).toBe(false);
    expect(text("#chatsEmpty")).toMatch(/No chats yet/);
    expect($("#addByName")).not.toBeNull();
    expect($("#defaultSound").disabled).toBe(true);
    expect($("#enabled").checked).toBe(true);
    expect($("#showPopups").checked).toBe(false);
  });

  it("explains what having no default sound means", () => {
    expect(text("#defaultHint")).toMatch(/WhatsApp's normal sound/);
  });

  it("labels every control so it is usable with a screen reader", () => {
    for (const id of ["ruleName", "ruleSound", "defaultSound", "volume"]) {
      expect(document.querySelector(`label[for="${id}"]`), `label for #${id}`).not.toBeNull();
    }
    expect($("#search").getAttribute("aria-label")).toBeTruthy();
    expect($("#message").getAttribute("aria-live")).toBe("polite");
  });
});

describe("your chats: one dropdown per chat", () => {
  beforeEach(() => mount({ initial: { recentSenders }, setup: twoSounds }));

  it("lists the chats that messaged you, newest first, hiding the empty message", () => {
    expect($("#chatsEmpty").hidden).toBe(true);
    expect($$("#chatList .name").map((n) => n.textContent)).toEqual(["Radwa", "Family"]);
    expect(rowOf("Family").textContent).toContain("Group");
  });

  it("offers default, silent, every loaded sound, and uploading a new one", () => {
    const labels = [...selectOf("Radwa").options].map((o) => o.textContent);
    expect(labels).toEqual([
      "Default sound",
      "Silent (no sound)",
      "Chime.mp3", // same upload time, so alphabetical
      "Ping.mp3",
      "＋ Upload new sound…",
    ]);
  });

  it("sets a chat's sound with a single change, bound to the chat id", async () => {
    choose("Radwa", "id1");
    await vi.waitFor(async () => expect((await store.load()).rules).toHaveLength(1));
    expect((await store.load()).rules[0]).toMatchObject({
      kind: "chat",
      match: "Radwa",
      chatId: "601@lid",
      action: "sound",
      soundId: "id1",
    });
    await vi.waitFor(() => expect(rowOf("Radwa").classList.contains("is-set")).toBe(true));
    expect(selectOf("Radwa").value).toBe("id1");
    expect(text('[data-sound-id="id1"] .meta')).toMatch(/used by 1/);
  });

  it("keeps keyboard focus on the dropdown after a change", async () => {
    choose("Radwa", "id1");
    await vi.waitFor(() => expect(document.activeElement).toBe(selectOf("Radwa")));
  });

  it("can silence a chat", async () => {
    choose("Family", "__silent");
    await vi.waitFor(async () =>
      expect((await store.load()).rules[0]).toMatchObject({ action: "silent" })
    );
    expect(selectOf("Family").value).toBe("__silent");
  });

  it("returns a chat to the default sound by removing its rule", async () => {
    choose("Radwa", "id1");
    await vi.waitFor(() => expect(rowOf("Radwa").classList.contains("is-set")).toBe(true));
    choose("Radwa", "__default");
    await vi.waitFor(async () => expect((await store.load()).rules).toEqual([]));
    expect(rowOf("Radwa")).toBeTruthy(); // still listed, since it has messaged you
    expect(rowOf("Radwa").classList.contains("is-set")).toBe(false);
    expect(selectOf("Radwa").value).toBe("__default");
  });

  it("filters the list as you type", () => {
    $("#search").value = "fam";
    fire($("#search"), "input");
    expect($$("#chatList li")).toHaveLength(1);
    $("#search").value = "zzz";
    fire($("#search"), "input");
    expect(text("#chatsEmpty")).toMatch(/Nothing matches/);
  });

  it("shows names as plain text, never as HTML", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    await mount({
      initial: { recentSenders: [{ name: evil, kind: "chat", chatId: "1@lid", lastSeen: 1 }] },
    });
    expect($("#chatList img")).toBeNull();
    expect(text("#chatList .name")).toBe(evil);
  });
});

describe("chats that have a rule but have not messaged yet", () => {
  beforeEach(() =>
    mount({
      initial: { recentSenders },
      setup: async (s) => {
        await twoSounds(s);
        await s.addRule({ kind: "chat", match: "Amy", action: "sound", soundId: "id2" });
      },
    })
  );

  it("are listed after the seen chats and show their sound", () => {
    expect($$("#chatList .name").map((n) => n.textContent)).toEqual(["Radwa", "Family", "Amy"]);
    expect(selectOf("Amy").value).toBe("id2");
    expect(rowOf("Amy").classList.contains("is-set")).toBe(true);
  });

  it("drop off the list when set back to the default sound", async () => {
    choose("Amy", "__default");
    await vi.waitFor(() => expect(rowOf("Amy")).toBeUndefined());
  });
});

describe("uploading a new sound straight from a chat's dropdown", () => {
  beforeEach(() => mount({ initial: { recentSenders }, setup: twoSounds }));

  it("opens the file picker instead of leaving the dropdown on 'Upload'", () => {
    $("#assignFile").click = vi.fn();
    choose("Radwa", "__upload");
    expect($("#assignFile").click).toHaveBeenCalledTimes(1);
  });

  it("uploads the file and gives it to that chat in one step", async () => {
    choose("Radwa", "__upload");
    pickFile(fakeFile("meow.mp3"));
    fire($("#assignFile"), "change");

    await vi.waitFor(async () => expect((await store.load()).rules).toHaveLength(1));
    const state = await store.load();
    const meow = Object.values(state.sounds).find((s) => s.name === "meow.mp3");
    expect(meow).toBeTruthy();
    expect(state.rules[0]).toMatchObject({ match: "Radwa", chatId: "601@lid", soundId: meow.id });
    expect(text("#message")).toBe('Added "meow.mp3" for Radwa.');
    await vi.waitFor(() => expect(selectOf("Radwa").value).toBe(meow.id));
    expect($$("#soundList li")).toHaveLength(3);
  });

  it("puts the dropdown back when the picker is cancelled", async () => {
    choose("Radwa", "__upload");
    pickFile(); // nothing chosen
    fire($("#assignFile"), "cancel");
    await vi.waitFor(() => expect(selectOf("Radwa").value).toBe("__default"));
    expect(Object.keys((await store.load()).sounds)).toHaveLength(2);
  });

  it("shows a clear error for an unsupported file and changes nothing", async () => {
    choose("Radwa", "__upload");
    pickFile(fakeFile("notes.txt", "text/plain"));
    fire($("#assignFile"), "change");
    await vi.waitFor(() => expect(text("#message")).toMatch(/isn't supported/));
    expect($("#message").className).toContain("toast-error");
    expect(selectOf("Radwa").value).toBe("__default");
    expect((await store.load()).rules).toEqual([]);
  });
});

describe("adding a chat by name", () => {
  beforeEach(() => mount({ initial: { recentSenders }, setup: twoSounds }));

  it("adds a chat that has not messaged you yet", async () => {
    $("#ruleName").value = "  Mom ";
    $("#ruleSound").value = "id1";
    submitAddByName();
    await vi.waitFor(() => expect(rowOf("Mom")).toBeTruthy());
    expect((await store.load()).rules[0]).toMatchObject({
      match: "Mom",
      chatId: null,
      soundId: "id1",
    });
    expect($("#ruleName").value).toBe("");
    expect(selectOf("Mom").value).toBe("id1");
  });

  it("recognises a name from your recent chats and does not list it twice", async () => {
    $("#ruleName").value = "radwa";
    $("#ruleSound").value = "__silent";
    submitAddByName();
    await vi.waitFor(async () => expect((await store.load()).rules).toHaveLength(1));
    expect((await store.load()).rules[0].chatId).toBe("601@lid");
    expect($$("#chatList .name").map((n) => n.textContent)).toEqual(["Radwa", "Family"]);
    expect(rowOf("Radwa").classList.contains("is-set")).toBe(true);
  });

  it("explains a duplicate and an empty name", async () => {
    await store.addRule({ kind: "chat", match: "Mom", action: "silent" });
    $("#ruleName").value = "mom";
    submitAddByName();
    await vi.waitFor(() => expect(text("#message")).toMatch(/already have a rule/));
    $("#ruleName").value = "   ";
    submitAddByName();
    await vi.waitFor(() => expect(text("#message")).toMatch(/Enter a name/));
  });
});

describe("sounds", () => {
  const upload = (...files) => {
    Object.defineProperty($("#soundFile"), "files", { value: files, configurable: true });
    fire($("#soundFile"), "change");
  };

  it("adds an uploaded sound and makes the first one the default", async () => {
    upload(fakeFile("ping.mp3"));
    await vi.waitFor(() => expect($$("#soundList li")).toHaveLength(1));
    const state = await store.load();
    expect(state.settings.defaultSoundId).toBe(Object.keys(state.sounds)[0]);
    expect(text("#message")).toMatch(/Added "ping.mp3"/);
    expect($(".badge").textContent).toBe("Default");
    expect($("#defaultSound").disabled).toBe(false);
    expect(text("#defaultHint")).toMatch(/no sound of its own/);
  });

  it("keeps the existing default when more sounds are added", async () => {
    upload(fakeFile("a.mp3"));
    await vi.waitFor(() => expect($$("#soundList li")).toHaveLength(1));
    const first = (await store.load()).settings.defaultSoundId;
    upload(fakeFile("b.mp3"), fakeFile("c.mp3"));
    await vi.waitFor(() => expect($$("#soundList li")).toHaveLength(3));
    expect((await store.load()).settings.defaultSoundId).toBe(first);
  });

  it("rejects an unsupported file with a clear message and stores nothing", async () => {
    upload(fakeFile("notes.txt", "text/plain"));
    await vi.waitFor(() => expect(text("#message")).toMatch(/isn't supported/));
    expect(Object.keys((await store.load()).sounds)).toEqual([]);
  });

  it("changes the default sound, including back to none", async () => {
    await mount({ setup: twoSounds });
    $("#defaultSound").value = "id2";
    fire($("#defaultSound"), "change");
    await vi.waitFor(async () => expect((await store.load()).settings.defaultSoundId).toBe("id2"));
    $("#defaultSound").value = "";
    fire($("#defaultSound"), "change");
    await vi.waitFor(async () => expect((await store.load()).settings.defaultSoundId).toBeNull());
    expect(text("#defaultHint")).toMatch(/WhatsApp's normal sound/);
  });

  it("previews a sound and can make another one the default", async () => {
    await mount({
      setup: async (s) => {
        await twoSounds(s);
        await s.setSettings({ defaultSoundId: "id1" });
      },
    });
    $('[data-sound-id="id1"] .preview').click();
    expect(player.toggle).toHaveBeenCalledWith("id1");
    $('[data-sound-id="id2"] .make-default').click();
    await vi.waitFor(async () => expect((await store.load()).settings.defaultSoundId).toBe("id2"));
  });

  it("asks before deleting, and keeps the sound if you cancel", async () => {
    await mount({
      setup: async (s) => {
        const sound = await s.addSound(fakeFile());
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
      initial: { recentSenders },
      setup: async (s) => {
        const sound = await s.addSound(fakeFile());
        await s.addRule({
          kind: "chat",
          match: "Radwa",
          chatId: "601@lid",
          action: "sound",
          soundId: sound.id,
        });
      },
    });
    expect(selectOf("Radwa").value).toBe("id1");
    $(".delete-sound").click();
    await vi.waitFor(() => expect($$("#soundList li")).toHaveLength(0));
    expect(selectOf("Radwa").value).toBe("__default");
    expect(text("#message")).toMatch(/Deleted/);
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

describe("new chats while the page is open", () => {
  beforeEach(() => mount({ initial: { recentSenders }, setup: twoSounds }));

  const newChatArrives = () => {
    storage.data.recentSenders = [
      { name: "Newcomer", kind: "chat", chatId: "7@lid", lastSeen: 9 },
      ...recentSenders,
    ];
    changeListeners.forEach((fn) => fn({ recentSenders: {} }, "local"));
  };

  it("adds them to the list without reloading", async () => {
    newChatArrives();
    await vi.waitFor(() => expect(rowOf("Newcomer")).toBeTruthy());
    expect($$("#chatList .name")[0].textContent).toBe("Newcomer");
  });

  it("waits until you leave a dropdown, so an open menu is never yanked away", async () => {
    const select = selectOf("Radwa");
    select.focus();
    newChatArrives();
    await new Promise((r) => setTimeout(r, 20));
    expect(rowOf("Newcomer")).toBeUndefined();

    fire(select, "focusout");
    await vi.waitFor(() => expect(rowOf("Newcomer")).toBeTruthy());
  });

  it("ignores storage changes that are not about chats", () => {
    const before = storage.calls.get;
    changeListeners.forEach((fn) => fn({ rules: {} }, "local"));
    changeListeners.forEach((fn) => fn({ recentSenders: {} }, "sync"));
    expect(storage.calls.get).toBe(before);
  });
});
