import {
  addChatByName,
  applyChoice,
  describeScan,
  refreshChatsFromWhatsApp,
} from "./chat-actions.mjs";
import { fillSelect, h } from "./dom.mjs";
import { mountHealth } from "./health-ui.mjs";
import { icon } from "./icons.mjs";
import { createSoundPlayer } from "./sound-player.mjs";
import { STRINGS as S, errorMessage } from "./strings.mjs";
import {
  CHOICE_DEFAULT,
  CHOICE_SILENT,
  buildChatRows,
  buildSoundRows,
  chatsToShow,
  defaultSoundHint,
  soundChoices,
} from "./view-model.mjs";

const POPUP_LIMIT = 8;

/**
 * The toolbar popup: your chats, each with one dropdown to pick its sound, including uploading a
 * new sound inline.
 */
export async function mountPopup({
  document,
  stateStore,
  chrome,
  useUploadWindow,
  soundStore,
  player: givenPlayer,
}) {
  const el = (tag, props, ...kids) => h(document, tag, props, ...kids);
  const win = document.defaultView;
  const player = givenPlayer ?? createSoundPlayer({ soundStore, window: win });
  // Chrome, Edge and other Chromium browsers keep a popup open while a file picker is showing.
  // Firefox (and Safari) close it, losing the chosen file, so they upload in a small window.
  const useWindow = useUploadWindow ?? !/Chrome\//.test(win.navigator?.userAgent ?? "");
  const percent = (value) => `${Math.round(Number(value) * 100)}%`;

  let state = await stateStore.load();
  let toastTimer = null;
  let chatsStale = false;
  let query = "";

  // ---------------------------------------------------------------- controls

  const enabled = el("input", {
    type: "checkbox",
    role: "switch",
    id: "enabled",
    onChange: onEnabled,
  });
  const defaultSound = el("select", {
    id: "defaultSound",
    class: "select",
    onChange: onDefaultSound,
  });
  const defaultHint = el("p", { class: "hint", id: "defaultHint" });
  const volume = el("input", {
    id: "volume",
    type: "range",
    min: 0,
    max: 1,
    step: 0.05,
    onInput: () => (volumeOut.textContent = percent(volume.value)),
    onChange: onVolume,
  });
  const volumeOut = el("output", { for: "volume", class: "volume-out" });
  const message = el("div", {
    id: "message",
    class: "toast",
    role: "status",
    "aria-live": "polite",
    hidden: true,
  });
  // Shown until a chat has its own sound or a default sound is set.
  const firstRun = el(
    "section",
    { class: "block first-run", id: "firstRun" },
    el("h2", {}, S.firstRunTitle),
    el("ol", {}, ...S.firstRunSteps.map((step) => el("li", {}, step))),
    el("p", { class: "hint" }, S.firstRunNote)
  );

  const chatList = el("ul", { id: "chatList", class: "chat-list", onFocusout: onChatsFocusOut });
  const chatsEmpty = el("p", { class: "empty", id: "chatsEmpty" }, S.chatsEmpty);
  const chatsMore = el("p", { class: "hint", id: "chatsMore", hidden: true }, S.chatsMore);
  const chatSearch = el("input", {
    id: "chatSearch",
    class: "input",
    type: "search",
    placeholder: S.searchPlaceholder,
    "aria-label": S.search,
    onInput: (event) => {
      query = event.target.value;
      renderChats();
    },
  });
  const refreshButton = el(
    "button",
    {
      id: "refreshChats",
      class: "btn btn-secondary btn-small",
      type: "button",
      title: S.refreshChats,
      onClick: onRefresh,
    },
    icon(document, "refresh", 15),
    S.refreshChats
  );

  const quickName = el("input", {
    id: "quickName",
    class: "input",
    type: "text",
    maxlength: 200,
    autocomplete: "off",
    placeholder: S.popupNamePlaceholder,
  });
  const quickSound = el("select", { id: "quickSound", class: "select" });
  const quickAdd = el(
    "form",
    { id: "quickAdd", class: "quick-add", onSubmit: onAdd },
    el("label", { class: "visually-hidden", for: "quickName" }, S.nameLabel),
    quickName,
    el("label", { class: "visually-hidden", for: "quickSound" }, S.soundLabel),
    quickSound,
    el("button", { class: "btn btn-primary", type: "submit" }, icon(document, "plus"), S.addRule)
  );

  const page = el(
    "div",
    { class: "popup" },
    el(
      "header",
      { class: "popup-header" },
      el(
        "div",
        { class: "brand" },
        el("span", { class: "brand-mark" }, icon(document, "bell", 20)),
        el("h1", {}, S.appName)
      ),
      el(
        "label",
        { class: "switch" },
        enabled,
        el("span", { class: "track", "aria-hidden": "true" }),
        el("span", { class: "visually-hidden" }, S.enabled)
      )
    ),
    message,
    firstRun,
    mountHealth({ document, stateStore, chrome }),
    el(
      "section",
      { class: "block sound-block" },
      el(
        "div",
        { class: "field" },
        el("label", { for: "defaultSound" }, S.defaultSound),
        defaultSound
      ),
      el(
        "div",
        { class: "field" },
        el("label", { for: "volume" }, S.volume),
        el("div", { class: "range-row" }, volume, volumeOut)
      ),
      defaultHint
    ),
    el(
      "section",
      { class: "block" },
      el("div", { class: "block-head" }, el("h2", {}, S.chatsTitle), refreshButton),
      chatSearch,
      chatList,
      chatsMore,
      chatsEmpty
    ),
    el(
      "details",
      { class: "add-by-name" },
      el("summary", {}, S.addByName),
      el("p", { class: "hint" }, S.addByNameHint),
      quickAdd
    ),
    el(
      "button",
      {
        class: "btn btn-secondary btn-block",
        id: "openSettings",
        type: "button",
        onClick: openSettings,
      },
      icon(document, "settings"),
      S.popupOpenSettings
    )
  );
  document.getElementById("app").replaceChildren(page);

  // ---------------------------------------------------------------- rendering

  function say(text, kind = "ok") {
    message.textContent = text;
    message.className = `toast toast-${kind}`;
    message.hidden = false;
    win.clearTimeout(toastTimer);
    toastTimer = win.setTimeout(() => (message.hidden = true), 3500);
  }

  function chatRow(row) {
    const select = el("select", {
      class: "select chat-sound",
      "aria-label": `${S.soundLabel}: ${row.name}`,
      onChange: (event) => onChatChoice(row.key, event.target),
    });
    fillSelect(document, select, soundChoices(state.sounds), row.choice);
    const playing = soundToPlay(row.choice);
    const playButton = el(
      "button",
      {
        class: "btn btn-secondary btn-small play-sound",
        type: "button",
        title: `${S.playFor} ${row.name}`,
        "aria-label": `${S.playFor} ${row.name}`,
        disabled: !playing,
        onClick: () => playing && player.play(playing),
      },
      icon(document, "speaker", 15),
      S.play
    );
    const fileInput = el("input", {
      type: "file",
      accept: "audio/*",
      class: "visually-hidden row-file",
      tabindex: -1,
      "aria-hidden": "true",
      onChange: (event) => onRowFile(row.key, event.target),
    });
    const uploadButton = el(
      "button",
      {
        class: "btn btn-secondary btn-small upload-for-chat",
        type: "button",
        title: `${S.uploadFor} ${row.name}`,
        "aria-label": `${S.uploadFor} ${row.name}`,
        // Where the browser would close the popup as soon as a file picker opens, upload in a
        // small window instead; elsewhere the picker opens right here.
        onClick: () => (useWindow ? openUploadWindow(row.key, fileInput) : fileInput.click()),
      },
      icon(document, "upload", 15),
      S.uploadButton
    );
    return el(
      "li",
      { dataset: { key: row.key }, class: row.hasRule ? "is-set" : "" },
      el(
        "div",
        { class: "chat-name" },
        el("span", { class: "name" }, row.name),
        el("span", { class: "meta" }, row.kindLabel),
        row.hasRule
          ? el(
              "span",
              { class: `link-status ${row.linked ? "is-linked" : "is-waiting"}` },
              row.linked ? S.linked : S.waitingLink
            )
          : null
      ),
      select,
      playButton,
      uploadButton,
      fileInput
    );
  }

  function renderChats() {
    // Only chats that already have a sound are listed; the search finds the rest.
    const view = chatsToShow(buildChatRows(state), query, POPUP_LIMIT);
    chatList.replaceChildren(...view.rows.map(chatRow));
    chatsEmpty.hidden = view.rows.length > 0;
    if (view.rows.length === 0) {
      const anything = state.recentSenders.length + state.rules.length + state.knownChats.length;
      chatsEmpty.textContent = view.searching
        ? S.chatsNoMatch
        : anything === 0
          ? S.chatsEmpty
          : S.chatsSearchPrompt;
    }
    chatsMore.hidden = view.more === 0;
  }

  function render() {
    enabled.checked = state.settings.enabled;
    volume.value = String(state.settings.volume);
    volumeOut.textContent = percent(state.settings.volume);

    const sounds = buildSoundRows(state);
    firstRun.hidden = state.rules.length > 0 || Boolean(state.settings.defaultSoundId);
    fillSelect(
      document,
      defaultSound,
      [{ value: "", label: S.noDefault }, ...sounds.map((s) => ({ value: s.id, label: s.name }))],
      state.settings.defaultSoundId ?? ""
    );
    defaultSound.disabled = sounds.length === 0;
    defaultHint.textContent = defaultSoundHint(state);
    fillSelect(
      document,
      quickSound,
      soundChoices(state.sounds),
      quickSound.value || CHOICE_DEFAULT
    );
    renderChats();
  }

  /** The sound a chat's choice would play: its own, the default one, or none (silent). */
  function soundToPlay(choice) {
    if (choice === CHOICE_SILENT) return null;
    const id = choice === CHOICE_DEFAULT ? state.settings.defaultSoundId : choice;
    return id && state.sounds[id] ? id : null;
  }

  // ---------------------------------------------------------------- actions

  /** Run a store call, show the outcome, and re-sync the screen. Resolves true on success. */
  async function save(task, success) {
    let ok = true;
    try {
      await task();
      if (success) say(success);
    } catch (error) {
      ok = false;
      say(errorMessage(error), "error");
    }
    state = await stateStore.load();
    render();
    return ok;
  }

  function focusRow(key) {
    const item = [...chatList.children].find((li) => li.dataset.key === key);
    item?.querySelector("select")?.focus();
  }

  function onEnabled() {
    save(() => stateStore.setSettings({ enabled: enabled.checked }));
  }

  function onVolume() {
    save(() => stateStore.setSettings({ volume: Number(volume.value) }));
  }

  function onDefaultSound() {
    save(() => stateStore.setSettings({ defaultSoundId: defaultSound.value || null }));
  }

  async function onChatChoice(key, select) {
    const row = buildChatRows(state).find((r) => r.key === key);
    if (!row) return;
    await save(() => applyChoice(stateStore, row, select.value));
    focusRow(key);
  }

  // The row's upload button opens the file picker from a real click (Firefox refuses to open a
  // picker from any other event); when a file is chosen it is uploaded and given to that chat.
  async function onRowFile(key, input) {
    const file = input.files?.[0];
    const row = buildChatRows(state).find((r) => r.key === key);
    if (!file || !row) return;
    say(`${S.uploading} "${file.name}"…`); // proof the file arrived, before anything can fail
    let duplicate = false;
    const ok = await save(async () => {
      const sound = await stateStore.addSound(file);
      duplicate = sound.duplicate === true;
      await applyChoice(stateStore, row, sound.id);
    });
    if (ok && duplicate) say(`"${file.name}" ${S.alreadyAdded} for ${row.name}.`);
    else if (ok) say(`Added "${file.name}" for ${row.name}.`);
    input.value = "";
    focusRow(key);
  }

  async function onAdd(event) {
    event.preventDefault();
    const name = quickName.value.trim();
    const ok = await save(
      () => addChatByName(stateStore, state, name, quickSound.value),
      `Added "${name}".`
    );
    if (ok) quickName.value = "";
  }

  async function onRefresh() {
    say(S.scanning);
    refreshButton.disabled = true;
    const result = await refreshChatsFromWhatsApp(chrome);
    refreshButton.disabled = false;
    const outcome = describeScan(result);
    say(outcome.text, outcome.kind);
    state = await stateStore.load();
    renderChats();
  }

  /**
   * The small upload window; a tab where the browser has no windows API; and if it cannot open
   * either, the inline file picker (better than a button that does nothing).
   */
  function openUploadWindow(key, fileInput) {
    const url = chrome.runtime.getURL(`ui/upload.html?chat=${encodeURIComponent(key)}`);
    try {
      if (typeof chrome.windows?.create === "function") {
        chrome.windows.create({ url, type: "popup", width: 480, height: 380 });
      } else if (typeof chrome.tabs?.create === "function") {
        chrome.tabs.create({ url });
      } else {
        fileInput.click();
        return;
      }
    } catch {
      fileInput.click();
      return;
    }
    win.close?.();
  }

  function openSettings() {
    chrome.runtime.openOptionsPage();
    win.close?.();
  }

  // New chats arrive while the popup is open; do not yank a dropdown out from under the user.
  function onChatsFocusOut() {
    if (chatsStale) {
      chatsStale = false;
      renderChats();
    }
  }

  chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !(changes.recentSenders || changes.knownChats)) return;
    stateStore.load().then((next) => {
      state = next;
      if (chatList.contains(document.activeElement)) chatsStale = true;
      else renderChats();
    });
  });

  render();
}
