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
let tabs;

/** `setup(store)` runs before the page loads, to seed sounds/rules through the real store. */
async function mount({ initial = {}, setup } = {}) {
  tabs = {
    query: vi.fn(async () => [{ id: 5, active: true }]),
    sendMessage: vi.fn(async () => ({ ok: true, count: 0 })),
    update: vi.fn(async () => {}),
    getCurrent: vi.fn(async () => ({ id: 9 })),
  };
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
    chrome: { tabs, storage: { onChanged: { addListener: (fn) => changeListeners.push(fn) } } },
    createPlayer: () => player,
    confirmFn,
  });
}

const twoSounds = async (s) => {
  await s.addSound(fakeFile("Ping.mp3")); // id1
  await s.addSound(fakeFile("Chime.mp3")); // id2
};

/** Type into the search box, like a user would. */
const search = (query) => {
  $("#search").value = query;
  fire($("#search"), "input");
};
const shownNames = () => $$("#chatList .name").map((n) => n.textContent);
const findRow = (name) =>
  $$("#chatList li").find((li) => li.querySelector(".name").textContent === name);
/** The row for a chat, found by searching for it first (chats are only listed when searched). */
const rowOf = (name) => {
  if (!findRow(name)) search(name);
  return findRow(name);
};
const selectOf = (name) => rowOf(name).querySelector("select");
const choose = (name, value) => {
  const select = selectOf(name);
  select.value = value;
  fire(select, "change");
};
const submitAddByName = () =>
  $("#addRuleForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
beforeEach(() => mount());

describe("first run", () => {
  it("explains that chats load from WhatsApp, and has a last-resort way to add one by name", () => {
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

describe("the list shows only chats that have a sound; search finds the rest", () => {
  beforeEach(() =>
    mount({
      initial: { recentSenders, knownChats: [{ name: "Mom" }, { name: "Work" }] },
      setup: async (s) => {
        await twoSounds(s);
        await s.addRule({ kind: "chat", match: "Mom", action: "sound", soundId: "id1" });
      },
    })
  );

  it("starts with just the chats you already configured, not every chat", () => {
    expect(shownNames()).toEqual(["Mom"]);
    expect(rowOf("Mom").classList.contains("is-set")).toBe(true);
  });

  it("finds any chat as you type, newest activity first", () => {
    search("a");
    expect(shownNames()).toEqual(["Radwa", "Family"]);
    search("wor");
    expect(shownNames()).toEqual(["Work"]);
  });

  it("matches without caring about case, accents on invisible marks", () => {
    search("  RAD‎");
    expect(shownNames()).toEqual(["Radwa"]);
  });

  it("says what to do when nothing matches", () => {
    search("zzz");
    expect(shownNames()).toEqual([]);
    expect(text("#chatsEmpty")).toMatch(/No chat matches/);
    expect(text("#chatsEmpty")).toMatch(/Refresh/);
  });

  it("returns to the configured chats when the search is cleared", () => {
    search("a");
    search("");
    expect(shownNames()).toEqual(["Mom"]);
  });

  it("keeps a chat on screen after you give it a sound while searching", async () => {
    search("radwa");
    choose("Radwa", "id2");
    await vi.waitFor(() => expect(findRow("Radwa").classList.contains("is-set")).toBe(true));
    expect(shownNames()).toEqual(["Radwa"]);
    search("");
    expect(shownNames().sort()).toEqual(["Mom", "Radwa"]);
  });

  it("drops a chat from the default view once it is set back to the default sound", async () => {
    choose("Mom", "__default");
    await vi.waitFor(async () => expect((await store.load()).rules).toEqual([]));
    search("");
    expect(shownNames()).toEqual([]);
    expect(text("#chatsEmpty")).toMatch(/Search above/);
  });

  it("limits a big result list and says there are more", async () => {
    await mount({
      initial: { knownChats: Array.from({ length: 60 }, (_, i) => ({ name: `Chat ${i}` })) },
      setup: twoSounds,
    });
    search("chat");
    expect(shownNames()).toHaveLength(25);
    expect($("#chatsMore").hidden).toBe(false);
    search("chat 5");
    expect($("#chatsMore").hidden).toBe(true);
  });
});

describe("your chats: one dropdown per chat", () => {
  beforeEach(() => mount({ initial: { recentSenders }, setup: twoSounds }));

  it("offers default, silent and every loaded sound", () => {
    const labels = [...selectOf("Radwa").options].map((o) => o.textContent);
    expect(labels).toEqual([
      "Default sound",
      "Silent (no sound)",
      "Chime.mp3", // same upload time, so alphabetical
      "Ping.mp3",
    ]);
    expect(rowOf("Family").textContent).toContain("Group");
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
    await vi.waitFor(() => expect(findRow("Radwa").classList.contains("is-set")).toBe(true));
    expect(selectOf("Radwa").value).toBe("id1");
    expect(text('[data-sound-id="id1"] .meta')).toMatch(/used by 1/);
  });

  it("keeps keyboard focus on the dropdown after a change", async () => {
    choose("Radwa", "id1");
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(findRow("Radwa").querySelector("select"))
    );
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
    await vi.waitFor(() => expect(findRow("Radwa").classList.contains("is-set")).toBe(true));
    choose("Radwa", "__default");
    await vi.waitFor(async () => expect((await store.load()).rules).toEqual([]));
    expect(findRow("Radwa")).toBeTruthy(); // still shown while it is the search result
    expect(findRow("Radwa").classList.contains("is-set")).toBe(false);
    expect(selectOf("Radwa").value).toBe("__default");
  });

  it("shows names as plain text, never as HTML", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    await mount({
      initial: { recentSenders: [{ name: evil, kind: "chat", chatId: "1@lid", lastSeen: 1 }] },
    });
    search("img");
    expect($("#chatList img")).toBeNull();
    expect(text("#chatList .name")).toBe(evil);
  });
});

describe("every chat from WhatsApp's own chat list", () => {
  beforeEach(() =>
    mount({
      initial: {
        recentSenders,
        knownChats: [{ name: "Mom" }, { name: "Work" }, { name: "radwa" }],
      },
      setup: twoSounds,
    })
  );

  it("finds them all by searching, one row per name, recent activity first", () => {
    search("m");
    expect(shownNames()).toEqual(["Family", "Mom"]);
    expect(findRow("Mom").textContent).toContain("Chat or group");
    search("radwa");
    expect(shownNames()).toEqual(["Radwa"]); // the list entry and the chat that messaged are one row
  });

  it("gives one of them a sound in a single change, as a name-based rule", async () => {
    choose("Mom", "id1");
    await vi.waitFor(async () => expect((await store.load()).rules).toHaveLength(1));
    expect((await store.load()).rules[0]).toMatchObject({
      kind: "chat",
      match: "Mom",
      chatId: null,
      soundId: "id1",
    });
    await vi.waitFor(() => expect(findRow("Mom").classList.contains("is-set")).toBe(true));
  });

  it("reads the list from the WhatsApp tab when you press Refresh", async () => {
    tabs.sendMessage.mockImplementation(async () => {
      storage.data.knownChats = [{ name: "Brand New Chat" }, ...storage.data.knownChats];
      return { ok: true, count: 4 };
    });
    $("#refreshChats").click();
    await vi.waitFor(() => expect(text("#message")).toBe("Found 4 chats."));
    expect(rowOf("Brand New Chat")).toBeTruthy();
    expect(tabs.sendMessage).toHaveBeenCalledWith(5, { type: "wansc:scan-chats" });
  });

  it("brings a background WhatsApp tab forward for the scan and returns afterwards", async () => {
    tabs.query.mockResolvedValue([{ id: 5, active: false }]);
    $("#refreshChats").click();
    await vi.waitFor(() => expect(tabs.update).toHaveBeenCalledTimes(2));
    expect(tabs.update).toHaveBeenNthCalledWith(1, 5, { active: true });
    expect(tabs.update).toHaveBeenNthCalledWith(2, 9, { active: true });
  });

  it("tells you what to do when WhatsApp Web is not open", async () => {
    tabs.query.mockResolvedValue([]);
    $("#refreshChats").click();
    await vi.waitFor(() => expect(text("#message")).toMatch(/Open WhatsApp Web/));
    expect($("#message").className).toContain("toast-error");
    expect($("#refreshChats").disabled).toBe(false);
  });

  it("explains when the page's chat list could not be read", async () => {
    tabs.sendMessage.mockResolvedValue({ ok: false, reason: "no-chat-list", count: 0 });
    $("#refreshChats").click();
    await vi.waitFor(() => expect(text("#message")).toMatch(/Couldn't read the chat list/));
  });
});

describe("people inside groups (advanced) and the last-resort box", () => {
  it("hides the people section until someone has been seen in a group", async () => {
    await mount({ initial: { recentSenders }, setup: twoSounds });
    expect($("#people").hidden).toBe(true);
  });

  it("keeps people out of the chat list but lets you search for one and give a sound", async () => {
    await mount({
      initial: { recentSenders: [{ name: "Bob", kind: "sender", lastSeen: 5 }, ...recentSenders] },
      setup: twoSounds,
    });
    search("bob");
    expect(shownNames()).toEqual([]);
    expect($("#people").hidden).toBe(false);

    const select = $$("#peopleList li")
      .find((li) => li.textContent.includes("Bob"))
      .querySelector("select");
    select.value = "id1";
    fire(select, "change");
    await vi.waitFor(async () =>
      expect((await store.load()).rules[0]).toMatchObject({
        kind: "sender",
        match: "Bob",
        soundId: "id1",
      })
    );
  });

  it("describes adding by name as the last resort and says the name must match", () => {
    expect(text("#addByName summary")).toMatch(/Last resort/);
    expect(text("#addByName .hint")).toMatch(/must match WhatsApp exactly/);
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

  it("are listed right away, showing their sound", () => {
    expect(shownNames()).toEqual(["Amy"]);
    expect(selectOf("Amy").value).toBe("id2");
    expect(rowOf("Amy").classList.contains("is-set")).toBe(true);
  });

  it("drop off the list when set back to the default sound", async () => {
    choose("Amy", "__default");
    await vi.waitFor(() => expect(findRow("Amy")).toBeUndefined());
  });
});

describe("uploading a new sound for one chat, with the button on its row", () => {
  beforeEach(() => mount({ initial: { recentSenders }, setup: twoSounds }));

  const fileInputOf = (name) => rowOf(name).querySelector(".row-file");
  const uploadButtonOf = (name) => rowOf(name).querySelector(".upload-for-chat");
  const chooseFile = (name, ...files) => {
    Object.defineProperty(fileInputOf(name), "files", { value: files, configurable: true });
    fire(fileInputOf(name), "change");
  };

  it("gives every chat its own clearly labelled upload button", () => {
    expect(uploadButtonOf("Radwa").getAttribute("aria-label")).toBe("Upload a new sound for Radwa");
    expect(uploadButtonOf("Family").getAttribute("aria-label")).toBe(
      "Upload a new sound for Family"
    );
  });

  it("opens the file picker from the button's click (the only way Firefox allows)", () => {
    fileInputOf("Radwa").click = vi.fn();
    uploadButtonOf("Radwa").click();
    expect(fileInputOf("Radwa").click).toHaveBeenCalledTimes(1);
  });

  it("uploads the file and gives it to that chat in one step", async () => {
    chooseFile("Radwa", fakeFile("meow.mp3"));

    await vi.waitFor(async () => expect((await store.load()).rules).toHaveLength(1));
    const state = await store.load();
    const meow = Object.values(state.sounds).find((s) => s.name === "meow.mp3");
    expect(meow).toBeTruthy();
    expect(state.rules[0]).toMatchObject({ match: "Radwa", chatId: "601@lid", soundId: meow.id });
    expect(text("#message")).toBe('Added "meow.mp3" for Radwa.');
    await vi.waitFor(() => expect(findRow("Radwa").querySelector("select").value).toBe(meow.id));
    expect($$("#soundList li")).toHaveLength(3);
  });

  it("does nothing when the picker is cancelled (no file chosen)", async () => {
    chooseFile("Radwa");
    await new Promise((r) => setTimeout(r, 20));
    expect(Object.keys((await store.load()).sounds)).toHaveLength(2);
    expect((await store.load()).rules).toEqual([]);
  });

  it("shows a clear error for an unsupported file and changes nothing", async () => {
    chooseFile("Radwa", fakeFile("notes.txt", "text/plain"));
    await vi.waitFor(() => expect(text("#message")).toMatch(/isn't supported/));
    expect($("#message").className).toContain("toast-error");
    expect(findRow("Radwa").querySelector("select").value).toBe("__default");
    expect((await store.load()).rules).toEqual([]);
  });
});

describe("adding a chat by name (last resort)", () => {
  beforeEach(() => mount({ initial: { recentSenders }, setup: twoSounds }));

  it("adds a chat that is not in the list", async () => {
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
    search("radwa");
    expect(shownNames()).toEqual(["Radwa"]);
    expect(findRow("Radwa").classList.contains("is-set")).toBe(true);
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
    search(""); // back to the default view: only chats that have a sound
    $(".delete-sound").click();
    await vi.waitFor(() => expect($$("#soundList li")).toHaveLength(0));
    expect(findRow("Radwa")).toBeUndefined(); // no sound of its own any more, so not listed
    search("radwa");
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
      { name: "Rad Newcomer", kind: "chat", chatId: "7@lid", lastSeen: 9 },
      ...recentSenders,
    ];
    changeListeners.forEach((fn) => fn({ recentSenders: {} }, "local"));
  };

  it("shows them in the search results without reloading", async () => {
    search("rad");
    expect(shownNames()).toEqual(["Radwa"]);
    newChatArrives();
    await vi.waitFor(() => expect(shownNames()).toEqual(["Rad Newcomer", "Radwa"]));
  });

  it("waits until you leave a dropdown, so an open menu is never yanked away", async () => {
    search("rad");
    const select = findRow("Radwa").querySelector("select");
    select.focus();
    newChatArrives();
    await new Promise((r) => setTimeout(r, 20));
    expect(shownNames()).toEqual(["Radwa"]); // untouched while the dropdown has focus

    fire(select, "focusout");
    await vi.waitFor(() => expect(shownNames()).toEqual(["Rad Newcomer", "Radwa"]));
  });

  it("also reacts to chat names read from WhatsApp's list", async () => {
    search("zed");
    expect(shownNames()).toEqual([]);
    storage.data.knownChats = [{ name: "Zed" }];
    changeListeners.forEach((fn) => fn({ knownChats: {} }, "local"));
    await vi.waitFor(() => expect(shownNames()).toEqual(["Zed"]));
  });

  it("ignores storage changes that are not about chats", () => {
    const before = storage.calls.get;
    changeListeners.forEach((fn) => fn({ rules: {} }, "local"));
    changeListeners.forEach((fn) => fn({ recentSenders: {} }, "sync"));
    expect(storage.calls.get).toBe(before);
  });
});
