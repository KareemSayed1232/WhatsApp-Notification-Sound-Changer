import {
  addChatByName,
  applyChoice,
  describeScan,
  refreshChatsFromWhatsApp,
} from "./chat-actions.mjs";
import { fillSelect, h } from "./dom.mjs";
import { icon } from "./icons.mjs";
import { STRINGS as S, errorMessage } from "./strings.mjs";
import {
  CHOICE_DEFAULT,
  CHOICE_UPLOAD,
  buildChatRows,
  buildPeopleRows,
  buildSoundRows,
  chatsToShow,
  defaultSoundHint,
  soundChoices,
} from "./view-model.mjs";

/** Plays a stored sound for preview. Extension pages are not bound by WhatsApp's CSP. */
function createDefaultPlayer({ soundStore, window }) {
  let audio = null;
  let url = null;
  let playingId = null;

  function stop() {
    if (audio) audio.pause();
    if (url) window.URL.revokeObjectURL(url);
    audio = null;
    url = null;
    playingId = null;
  }

  return {
    stop,
    async toggle(soundId) {
      const wasPlaying = playingId === soundId;
      stop();
      if (wasPlaying) return;
      const record = await soundStore.get(soundId);
      if (!record) return;
      url = window.URL.createObjectURL(new window.Blob([record.data], { type: record.mime }));
      audio = new window.Audio(url);
      playingId = soundId;
      audio.addEventListener("ended", stop);
      await audio.play().catch(stop);
    },
  };
}

/**
 * The settings page. The main thing on it is one list of your chats: each row has a single
 * dropdown to pick its sound (a loaded one, silent, the default, or a brand-new upload).
 */
export async function mountOptions({
  document,
  stateStore,
  soundStore,
  chrome,
  createPlayer = createDefaultPlayer,
  confirmFn,
}) {
  const win = document.defaultView;
  const confirmAction = confirmFn ?? ((text) => win.confirm(text));
  const player = createPlayer({ soundStore, window: win });
  const el = (tag, props, ...kids) => h(document, tag, props, ...kids);
  const percent = (value) => `${Math.round(Number(value) * 100)}%`;

  let state = await stateStore.load();
  let filter = "";
  let toastTimer = null;
  let uploadTarget = null; // key of the chat whose "Upload new sound…" was chosen
  let chatsStale = false; // new chats arrived while a dropdown was open

  // ---------------------------------------------------------------- building blocks

  function switchControl({ id, label, onChange }) {
    const input = el("input", { type: "checkbox", role: "switch", id, onChange });
    const node = el(
      "label",
      { class: "switch" },
      input,
      el("span", { class: "track", "aria-hidden": "true" }),
      el("span", { class: "switch-text" }, label)
    );
    return { node, input };
  }

  function field(labelText, id, control) {
    return el("div", { class: "field" }, el("label", { for: id }, labelText), control);
  }

  const enabled = switchControl({ id: "enabled", label: S.enabled, onChange: onEnabled });
  const showPopups = switchControl({
    id: "showPopups",
    label: S.popupsLabel,
    onChange: onShowPopups,
  });

  const message = el("div", {
    id: "message",
    class: "toast",
    role: "status",
    "aria-live": "polite",
    hidden: true,
  });

  // Chats
  const search = el("input", {
    id: "search",
    class: "input",
    type: "search",
    placeholder: S.searchPlaceholder,
    "aria-label": S.search,
    onInput: (event) => {
      filter = event.target.value;
      renderChats();
    },
  });
  const chatList = el("ul", { id: "chatList", class: "chat-list", onFocusout: onChatsFocusOut });
  const chatsEmpty = el("p", { class: "empty", id: "chatsEmpty" });
  const chatsMore = el("p", { class: "hint", id: "chatsMore", hidden: true }, S.chatsMore);
  const refreshButton = el(
    "button",
    { id: "refreshChats", class: "btn btn-secondary", type: "button", onClick: onRefresh },
    icon(document, "refresh"),
    S.refreshChats
  );
  const peopleList = el("ul", {
    id: "peopleList",
    class: "chat-list",
    onFocusout: onChatsFocusOut,
  });
  const people = el(
    "details",
    { id: "people", class: "add-by-name", hidden: true },
    el("summary", {}, S.peopleTitle),
    el("p", { class: "hint" }, S.peopleHint),
    peopleList
  );
  const assignFile = el("input", {
    id: "assignFile",
    type: "file",
    accept: "audio/*",
    class: "visually-hidden",
    tabindex: -1,
    "aria-hidden": "true",
    onChange: onAssignFile,
    onCancel: onAssignFile,
  });

  // Add a chat by name
  const ruleName = el("input", {
    id: "ruleName",
    class: "input",
    type: "text",
    maxlength: 200,
    autocomplete: "off",
    placeholder: S.namePlaceholder,
  });
  const ruleSound = el("select", { id: "ruleSound", class: "select" });
  const addForm = el(
    "form",
    { id: "addRuleForm", class: "add-form", onSubmit: onAddByName },
    field(S.nameLabel, "ruleName", ruleName),
    field(S.soundLabel, "ruleSound", ruleSound),
    el("button", { class: "btn btn-primary", type: "submit" }, icon(document, "plus"), S.addRule)
  );

  // Sounds
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
  const soundFile = el("input", {
    id: "soundFile",
    type: "file",
    accept: "audio/*",
    multiple: true,
    class: "visually-hidden",
    onChange: onUpload,
  });
  const soundList = el("ul", { id: "soundList", class: "sound-list" });
  const soundsEmpty = el("p", { class: "empty", id: "soundsEmpty" }, S.soundsEmpty);

  const page = el(
    "div",
    { class: "page" },
    el(
      "header",
      { class: "page-header" },
      el(
        "div",
        { class: "brand" },
        el("span", { class: "brand-mark" }, icon(document, "bell", 22)),
        el("div", {}, el("h1", {}, S.appName), el("p", { class: "tagline" }, S.tagline))
      ),
      enabled.node
    ),
    message,
    el(
      "main",
      {},
      el(
        "section",
        { class: "card", "aria-labelledby": "h-chats" },
        el("h2", { id: "h-chats" }, S.chatsTitle),
        el("p", { class: "hint" }, S.chatsHint),
        el("div", { class: "toolbar" }, search, refreshButton),
        chatList,
        chatsMore,
        chatsEmpty,
        assignFile,
        people,
        el(
          "details",
          { class: "add-by-name", id: "addByName" },
          el("summary", {}, S.addByName),
          el("p", { class: "hint" }, S.addByNameHint),
          addForm
        )
      ),
      el(
        "section",
        { class: "card", "aria-labelledby": "h-sounds" },
        el("h2", { id: "h-sounds" }, S.soundsTitle),
        el("p", { class: "hint" }, S.soundsHint),
        el(
          "div",
          { class: "sound-settings" },
          field(S.defaultSound, "defaultSound", defaultSound),
          el(
            "div",
            { class: "field" },
            el("label", { for: "volume" }, S.volume),
            el("div", { class: "range-row" }, volume, volumeOut)
          )
        ),
        defaultHint,
        el(
          "div",
          { class: "toolbar" },
          el(
            "label",
            { class: "btn btn-primary", for: "soundFile" },
            icon(document, "upload"),
            S.addSound
          ),
          soundFile
        ),
        soundList,
        soundsEmpty
      ),
      el(
        "section",
        { class: "card", "aria-labelledby": "h-popups" },
        el("h2", { id: "h-popups" }, S.popupsTitle),
        showPopups.node,
        el("p", { class: "hint" }, S.popupsHint)
      )
    ),
    el("footer", { class: "page-footer" }, S.privacy)
  );

  document.getElementById("app").replaceChildren(page);

  // ---------------------------------------------------------------- rendering

  function say(text, kind = "ok") {
    message.textContent = text;
    message.className = `toast toast-${kind}`;
    message.hidden = false;
    win.clearTimeout(toastTimer);
    toastTimer = win.setTimeout(() => (message.hidden = true), 5000);
  }

  function renderSettings() {
    enabled.input.checked = state.settings.enabled;
    showPopups.input.checked = state.settings.showPopups;
    volume.value = String(state.settings.volume);
    volumeOut.textContent = percent(state.settings.volume);
  }

  function renderDefaultSound() {
    const rows = buildSoundRows(state);
    fillSelect(
      document,
      defaultSound,
      [
        { value: "", label: S.noDefault },
        ...rows.map((row) => ({ value: row.id, label: row.name })),
      ],
      state.settings.defaultSoundId ?? ""
    );
    defaultSound.disabled = rows.length === 0;
    defaultHint.textContent = defaultSoundHint(state);
  }

  function renderSoundPicker() {
    fillSelect(document, ruleSound, soundChoices(state.sounds), ruleSound.value || CHOICE_DEFAULT);
  }

  function renderSounds() {
    const rows = buildSoundRows(state);
    soundsEmpty.hidden = rows.length > 0;
    soundList.replaceChildren(
      ...rows.map((row) =>
        el(
          "li",
          { dataset: { soundId: row.id } },
          el(
            "div",
            { class: "sound-info" },
            el("span", { class: "name" }, row.name),
            el(
              "span",
              { class: "meta" },
              row.sizeLabel,
              row.usedBy > 0 ? ` · used by ${row.usedBy}` : ""
            ),
            row.isDefault ? el("span", { class: "badge" }, S.defaultBadge) : null
          ),
          el(
            "div",
            { class: "row-actions" },
            el(
              "button",
              {
                class: "icon-btn preview",
                type: "button",
                "aria-label": `${S.preview} ${row.name}`,
                title: S.preview,
                onClick: () => player.toggle(row.id),
              },
              icon(document, "play")
            ),
            row.isDefault
              ? null
              : el(
                  "button",
                  {
                    class: "icon-btn make-default",
                    type: "button",
                    "aria-label": `${S.setDefault}: ${row.name}`,
                    title: S.setDefault,
                    onClick: () => setDefaultSound(row.id),
                  },
                  icon(document, "star")
                ),
            el(
              "button",
              {
                class: "icon-btn danger delete-sound",
                type: "button",
                "aria-label": `${S.delete} ${row.name}`,
                title: S.delete,
                onClick: () => onDeleteSound(row),
              },
              icon(document, "trash")
            )
          )
        )
      )
    );
  }

  function chatRow(row) {
    const select = el("select", {
      class: "select chat-sound",
      "aria-label": `${S.soundLabel}: ${row.name}`,
      onChange: (event) => onChatChoice(row.key, event.target),
    });
    fillSelect(document, select, soundChoices(state.sounds, { allowUpload: true }), row.choice);
    return el(
      "li",
      { dataset: { key: row.key }, class: row.hasRule ? "is-set" : "" },
      el(
        "div",
        { class: "chat-name" },
        el("span", { class: "name" }, row.name),
        el(
          "span",
          { class: "meta" },
          row.kindLabel,
          row.chatId && row.hasRule
            ? el("span", { class: "linked", title: S.followsRenames }, icon(document, "link", 13))
            : null
        )
      ),
      select
    );
  }

  function renderChats() {
    // Only chats that already have a sound are listed; the search finds the rest.
    const view = chatsToShow(buildChatRows(state), filter);
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

    const peopleView = chatsToShow(buildPeopleRows(state), filter);
    peopleList.replaceChildren(...peopleView.rows.map(chatRow));
    people.hidden = peopleView.rows.length === 0;
  }

  function renderAll() {
    renderSettings();
    renderDefaultSound();
    renderSoundPicker();
    renderChats();
    renderSounds();
  }

  function focusRow(key) {
    const item = [...chatList.children].find((li) => li.dataset.key === key);
    item?.querySelector("select")?.focus();
  }

  // ---------------------------------------------------------------- actions

  async function refresh() {
    state = await stateStore.load();
    renderAll();
  }

  /** Run a store call; show a friendly error and re-sync the screen if it fails. */
  async function run(task, success) {
    try {
      const result = await task();
      state = await stateStore.load();
      if (success) say(success);
      return { ok: true, result };
    } catch (error) {
      say(errorMessage(error), "error");
      await refresh();
      return { ok: false };
    }
  }

  const findRow = (key) =>
    [...buildChatRows(state), ...buildPeopleRows(state)].find((row) => row.key === key);

  async function onRefresh() {
    say(S.scanning);
    refreshButton.disabled = true;
    const result = await refreshChatsFromWhatsApp(chrome, { bringToFront: true });
    refreshButton.disabled = false;
    const outcome = describeScan(result);
    say(outcome.text, outcome.kind);
    await refresh();
  }

  function onEnabled() {
    run(() => stateStore.setSettings({ enabled: enabled.input.checked }));
  }

  function onShowPopups() {
    run(() => stateStore.setSettings({ showPopups: showPopups.input.checked }));
  }

  function onVolume() {
    run(() => stateStore.setSettings({ volume: Number(volume.value) }));
  }

  function setDefaultSound(soundId) {
    return run(() => stateStore.setSettings({ defaultSoundId: soundId || null })).then(() => {
      renderDefaultSound();
      renderSounds();
    });
  }

  function onDefaultSound() {
    setDefaultSound(defaultSound.value);
  }

  // One click: pick a sound for a chat. "Upload new sound…" opens the file picker and then
  // uploads and assigns in one go.
  async function onChatChoice(key, select) {
    const row = findRow(key);
    if (!row) return;
    if (select.value === CHOICE_UPLOAD) {
      uploadTarget = key;
      assignFile.value = "";
      assignFile.click();
      return;
    }
    await run(() => applyChoice(stateStore, row, select.value));
    renderChats();
    renderSounds();
    focusRow(key);
  }

  async function onAssignFile() {
    const key = uploadTarget;
    uploadTarget = null;
    const file = assignFile.files?.[0];
    const row = key ? findRow(key) : null;
    if (!file || !row) {
      // The picker was cancelled: put the dropdown back to what it was.
      renderChats();
      if (key) focusRow(key);
      return;
    }
    const outcome = await run(async () => {
      const sound = await stateStore.addSound(file);
      await applyChoice(stateStore, row, sound.id);
    }, `Added "${file.name}" for ${row.name}.`);
    assignFile.value = "";
    if (outcome.ok) renderAll();
    else renderChats();
    focusRow(key);
  }

  async function onAddByName(event) {
    event.preventDefault();
    const name = ruleName.value.trim();
    const outcome = await run(
      () => addChatByName(stateStore, state, name, ruleSound.value),
      `Added "${name}".`
    );
    if (outcome.ok) {
      ruleName.value = "";
      renderChats();
      ruleName.focus();
    }
  }

  async function onUpload() {
    const files = [...(soundFile.files ?? [])];
    let added = 0;
    for (const file of files) {
      const outcome = await run(() => stateStore.addSound(file));
      if (!outcome.ok) break;
      added++;
      if (!state.settings.defaultSoundId) {
        await run(() => stateStore.setSettings({ defaultSoundId: outcome.result.id }));
      }
    }
    soundFile.value = "";
    if (added > 0) {
      renderAll();
      say(added === 1 ? `Added "${files[0].name}".` : `Added ${added} sounds.`);
    }
  }

  async function onDeleteSound(row) {
    const detail =
      row.usedBy > 0 || row.isDefault ? " Chats using it will go back to the default sound." : "";
    if (!confirmAction(`Delete "${row.name}"?${detail}`)) return;
    player.stop?.();
    const outcome = await run(() => stateStore.deleteSound(row.id), `Deleted "${row.name}".`);
    if (outcome.ok) renderAll();
  }

  // New chats arrive while this page is open; do not yank a dropdown out from under the user.
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

  renderAll();
  return { refresh };
}
