import { fillSelect, h } from "./dom.mjs";
import { icon } from "./icons.mjs";
import { STRINGS as S, errorMessage } from "./strings.mjs";
import {
  CHOICE_DEFAULT,
  buildRuleRows,
  buildSoundRows,
  choiceToAction,
  defaultSoundHint,
  recentChoices,
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

  let state = await stateStore.load();
  let filter = "";
  let linkedChatId = null; // chat id of the recent chat picked in the add form, if any
  let toastTimer = null;

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

  // Add-rule form
  const recent = el("select", { id: "recent", class: "select", onChange: onPickRecent });
  const ruleKind = el(
    "select",
    { id: "ruleKind", class: "select" },
    el("option", { value: "chat" }, S.kindChat),
    el("option", { value: "sender" }, S.kindSender)
  );
  const ruleName = el("input", {
    id: "ruleName",
    class: "input",
    type: "text",
    maxlength: 200,
    autocomplete: "off",
    placeholder: S.namePlaceholder,
    onInput: () => {
      linkedChatId = null; // typing by hand means it is no longer the chat that was picked
    },
  });
  const ruleSound = el("select", { id: "ruleSound", class: "select" });
  const addForm = el(
    "form",
    { id: "addRuleForm", class: "add-form", onSubmit: onAddRule },
    field(S.recentLabel, "recent", recent),
    field(S.kindLabel, "ruleKind", ruleKind),
    field(S.nameLabel, "ruleName", ruleName),
    field(S.soundLabel, "ruleSound", ruleSound),
    el("button", { class: "btn btn-primary", type: "submit" }, icon(document, "plus"), S.addRule)
  );
  const recentHelp = el("p", { class: "hint", id: "recentHelp" }, S.recentHelp);

  const search = el("input", {
    id: "search",
    class: "input",
    type: "search",
    placeholder: S.searchPlaceholder,
    "aria-label": S.search,
    onInput: (event) => {
      filter = event.target.value;
      renderRules();
    },
  });
  const rulesBody = el("tbody", { id: "rulesBody" });
  const rulesEmpty = el("p", { class: "empty", id: "rulesEmpty" });

  // Sounds
  const defaultSound = el("select", {
    id: "defaultSound",
    class: "select",
    onChange: onDefaultSound,
  });
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

  const percent = (value) => `${Math.round(Number(value) * 100)}%`;
  const defaultHint = el("p", { class: "hint", id: "defaultHint" });

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
        { class: "card", "aria-labelledby": "h-rules" },
        el("h2", { id: "h-rules" }, S.rulesTitle),
        el("p", { class: "hint" }, S.rulesHint),
        addForm,
        recentHelp,
        el("div", { class: "toolbar" }, search),
        el(
          "table",
          { class: "rules" },
          el("caption", { class: "visually-hidden" }, S.rulesTitle),
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", { scope: "col" }, S.colName),
              el("th", { scope: "col" }, S.colSound),
              el("th", { scope: "col" }, S.colOn),
              // Keep the cell in the table grid; only its text is hidden.
              el("th", { scope: "col" }, el("span", { class: "visually-hidden" }, S.delete))
            )
          ),
          rulesBody
        ),
        rulesEmpty
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
    const sounds = Object.values(state.sounds);
    fillSelect(
      document,
      defaultSound,
      [
        { value: "", label: S.noDefault },
        ...buildSoundRows(state).map((row) => ({ value: row.id, label: row.name })),
      ],
      state.settings.defaultSoundId ?? ""
    );
    defaultSound.disabled = sounds.length === 0;
    defaultHint.textContent = defaultSoundHint(state);
  }

  function renderSoundPicker() {
    fillSelect(document, ruleSound, soundChoices(state.sounds), ruleSound.value || CHOICE_DEFAULT);
  }

  function renderRecent() {
    const choices = recentChoices(state);
    fillSelect(
      document,
      recent,
      [
        { value: "", label: S.recentPlaceholder },
        ...choices.map((c) => ({ value: c.key, label: `${c.name} (${c.kindLabel})` })),
      ],
      ""
    );
    recent.disabled = choices.length === 0;
    recentHelp.hidden = choices.length > 0;
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

  function ruleRow(row) {
    const select = el("select", {
      class: "select rule-sound",
      "aria-label": `${S.soundLabel}: ${row.label}`,
      onChange: (event) =>
        run(() => stateStore.updateRule(row.id, choiceToAction(event.target.value))),
    });
    fillSelect(document, select, soundChoices(state.sounds), row.choice);

    const toggle = switchControl({
      id: `on-${row.id}`,
      label: row.label,
      onChange: (event) => {
        tr.classList.toggle("is-off", !event.target.checked);
        run(() => stateStore.updateRule(row.id, { enabled: event.target.checked }));
      },
    });
    toggle.input.checked = row.enabled;
    toggle.node.classList.add("switch-compact");
    toggle.node.querySelector(".switch-text").className = "visually-hidden";

    const tr = el(
      "tr",
      { dataset: { ruleId: row.id }, class: row.enabled ? "" : "is-off" },
      el(
        "td",
        { class: "cell-name", "data-label": S.colName },
        el("span", { class: "name" }, row.label),
        el(
          "span",
          { class: "meta" },
          row.kindLabel,
          row.linked
            ? el("span", { class: "linked", title: S.followsRenames }, icon(document, "link", 13))
            : null
        )
      ),
      el("td", { "data-label": S.colSound }, select),
      el("td", { class: "cell-on", "data-label": S.colOn }, toggle.node),
      el(
        "td",
        { class: "cell-actions" },
        el(
          "button",
          {
            class: "icon-btn danger delete-rule",
            type: "button",
            "aria-label": `${S.delete} ${row.label}`,
            title: S.delete,
            onClick: () => onDeleteRule(row.id),
          },
          icon(document, "trash")
        )
      )
    );
    return tr;
  }

  function renderRules() {
    const rows = buildRuleRows(state, filter);
    rulesBody.replaceChildren(...rows.map(ruleRow));
    rulesEmpty.hidden = rows.length > 0;
    rulesEmpty.textContent = state.rules.length === 0 ? S.rulesEmpty : S.rulesNoMatch;
  }

  function renderAll() {
    renderSettings();
    renderDefaultSound();
    renderSoundPicker();
    renderRecent();
    renderSounds();
    renderRules();
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
    return run(() => stateStore.setSettings({ defaultSoundId: soundId || null })).then(renderAfter);
  }

  function onDefaultSound() {
    setDefaultSound(defaultSound.value);
  }

  function renderAfter() {
    renderDefaultSound();
    renderSounds();
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

  function onPickRecent() {
    const choice = recentChoices(state).find((c) => c.key === recent.value);
    if (!choice) return;
    ruleKind.value = choice.kind;
    ruleName.value = choice.name;
    linkedChatId = choice.chatId;
    ruleSound.focus();
  }

  async function onAddRule(event) {
    event.preventDefault();
    const name = ruleName.value.trim();
    const outcome = await run(
      () =>
        stateStore.addRule({
          kind: ruleKind.value,
          match: name,
          chatId: ruleKind.value === "chat" ? linkedChatId : null,
          ...choiceToAction(ruleSound.value),
        }),
      `Added "${name}".`
    );
    if (outcome.ok) {
      ruleName.value = "";
      linkedChatId = null;
      renderAll();
      ruleName.focus();
    }
  }

  async function onDeleteRule(id) {
    const outcome = await run(() => stateStore.deleteRule(id));
    if (outcome.ok) {
      renderRules();
      renderRecent();
    }
  }

  // The background worker records new chats while this page is open.
  chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.recentSenders) {
      stateStore.load().then((next) => {
        state = next;
        renderRecent();
      });
    }
  });

  renderAll();
  return { refresh };
}
