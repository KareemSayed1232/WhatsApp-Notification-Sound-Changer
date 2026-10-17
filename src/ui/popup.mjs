import { normalizeName } from "../core/normalize.mjs";
import { fillSelect, h } from "./dom.mjs";
import { icon } from "./icons.mjs";
import { STRINGS as S, errorMessage } from "./strings.mjs";
import {
  CHOICE_DEFAULT,
  buildRuleRows,
  buildSoundRows,
  choiceToAction,
  recentChoices,
  soundChoices,
} from "./view-model.mjs";

const RECENT_LIMIT = 5;

/**
 * The toolbar popup: everything you need day to day without leaving the page. Default sound and
 * volume, a sound for each chat, adding a chat by name, and one-tap sounds for chats that just
 * messaged you. Uploading sounds lives on the settings page (a file picker can close a popup).
 */
export async function mountPopup({ document, stateStore, chrome }) {
  const el = (tag, props, ...kids) => h(document, tag, props, ...kids);
  const win = document.defaultView;
  const percent = (value) => `${Math.round(Number(value) * 100)}%`;

  let state = await stateStore.load();
  let toastTimer = null;

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
  const needSound = el(
    "p",
    { class: "banner", id: "needSound" },
    icon(document, "speaker"),
    S.popupNeedSound
  );

  const rulesList = el("ul", { id: "rulesList", class: "chat-list" });
  const rulesEmpty = el("p", { class: "empty", id: "rulesEmpty" }, S.popupChatsEmpty);

  const quickName = el("input", {
    id: "quickName",
    class: "input",
    type: "text",
    maxlength: 200,
    autocomplete: "off",
    list: "quickRecents",
    placeholder: S.popupNamePlaceholder,
  });
  const quickRecents = el("datalist", { id: "quickRecents" });
  const quickSound = el("select", { id: "quickSound", class: "select" });
  const quickAdd = el(
    "form",
    { id: "quickAdd", class: "quick-add", onSubmit: onAdd },
    el("label", { class: "visually-hidden", for: "quickName" }, S.nameLabel),
    quickName,
    quickRecents,
    el("label", { class: "visually-hidden", for: "quickSound" }, S.soundLabel),
    quickSound,
    el("button", { class: "btn btn-primary", type: "submit" }, icon(document, "plus"), S.addRule)
  );

  const recentList = el("ul", { id: "recentList", class: "chat-list" });
  const recentEmpty = el("p", { class: "empty", id: "recentEmpty" }, S.popupRecentEmpty);

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
    needSound,
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
      )
    ),
    el("section", { class: "block" }, el("h2", {}, S.popupChatsTitle), rulesList, rulesEmpty),
    el(
      "section",
      { class: "block" },
      el("h2", {}, S.popupAddTitle),
      quickAdd,
      el("p", { class: "hint" }, S.popupAddHint)
    ),
    el("section", { class: "block" }, el("h2", {}, S.popupRecent), recentList, recentEmpty),
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

  function chatRow({ key, name, meta, controls }) {
    return el(
      "li",
      { dataset: { key }, class: controls.length > 1 ? "has-delete" : "" },
      el(
        "div",
        { class: "chat-name" },
        el("span", { class: "name" }, name),
        el("span", { class: "meta" }, meta)
      ),
      ...controls
    );
  }

  function renderRules() {
    const rows = buildRuleRows(state);
    rulesEmpty.hidden = rows.length > 0;
    rulesList.replaceChildren(
      ...rows.map((row) => {
        const select = el("select", {
          class: "select",
          "aria-label": `${S.soundLabel}: ${row.label}`,
          onChange: (event) => changeRule(row.id, event.target.value),
        });
        fillSelect(document, select, soundChoices(state.sounds), row.choice);
        const remove = el(
          "button",
          {
            class: "icon-btn danger delete-rule",
            type: "button",
            "aria-label": `${S.delete} ${row.label}`,
            title: S.delete,
            onClick: () => removeRule(row.id),
          },
          icon(document, "trash")
        );
        return chatRow({
          key: row.id,
          name: row.label,
          meta: row.kindLabel,
          controls: [select, remove],
        });
      })
    );
  }

  function renderRecent() {
    const choices = recentChoices(state, RECENT_LIMIT);
    recentEmpty.hidden = choices.length > 0;
    recentList.replaceChildren(
      ...choices.map((choice) => {
        const select = el("select", {
          class: "select",
          "aria-label": `${S.soundLabel}: ${choice.name}`,
          onChange: (event) => assignRecent(choice, event.target.value),
        });
        fillSelect(
          document,
          select,
          [{ value: "", label: S.chooseSound }, ...soundChoices(state.sounds)],
          ""
        );
        return chatRow({
          key: choice.key,
          name: choice.name,
          meta: choice.kindLabel,
          controls: [select],
        });
      })
    );
    quickRecents.replaceChildren(
      ...recentChoices(state).map((choice) => el("option", { value: choice.name }))
    );
  }

  function render() {
    enabled.checked = state.settings.enabled;
    volume.value = String(state.settings.volume);
    volumeOut.textContent = percent(state.settings.volume);

    const sounds = buildSoundRows(state);
    needSound.hidden = sounds.length > 0;
    fillSelect(
      document,
      defaultSound,
      [{ value: "", label: S.noDefault }, ...sounds.map((s) => ({ value: s.id, label: s.name }))],
      state.settings.defaultSoundId ?? ""
    );
    defaultSound.disabled = sounds.length === 0;
    fillSelect(
      document,
      quickSound,
      soundChoices(state.sounds),
      quickSound.value || CHOICE_DEFAULT
    );

    renderRules();
    renderRecent();
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

  function onEnabled() {
    save(() => stateStore.setSettings({ enabled: enabled.checked }));
  }

  function onVolume() {
    save(() => stateStore.setSettings({ volume: Number(volume.value) }));
  }

  function onDefaultSound() {
    save(() => stateStore.setSettings({ defaultSoundId: defaultSound.value || null }));
  }

  function changeRule(id, choice) {
    save(() => stateStore.updateRule(id, choiceToAction(choice)), S.saved);
  }

  function removeRule(id) {
    save(() => stateStore.deleteRule(id));
  }

  function assignRecent(choice, value) {
    if (!value) return; // the "Choose a sound…" placeholder
    save(
      () =>
        stateStore.addRule({
          kind: choice.kind,
          match: choice.name,
          chatId: choice.kind === "chat" ? choice.chatId : null,
          ...choiceToAction(value),
        }),
      S.saved
    );
  }

  /** Typing a name that matches a recent chat binds the rule to that chat's id. */
  function lookupRecent(name) {
    const wanted = normalizeName(name);
    const seen = state.recentSenders.filter((s) => normalizeName(s.name) === wanted);
    return seen.find((s) => s.kind === "chat") ?? seen[0] ?? null;
  }

  async function onAdd(event) {
    event.preventDefault();
    const name = quickName.value.trim();
    const known = lookupRecent(name);
    const ok = await save(
      () =>
        stateStore.addRule({
          kind: known?.kind ?? "chat",
          match: name,
          chatId: known?.kind === "chat" ? (known.chatId ?? null) : null,
          ...choiceToAction(quickSound.value),
        }),
      `Added "${name}".`
    );
    if (ok) quickName.value = "";
  }

  function openSettings() {
    chrome.runtime.openOptionsPage();
    win.close?.();
  }

  chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.recentSenders) {
      stateStore.load().then((next) => {
        state = next;
        renderRecent();
      });
    }
  });

  render();
}
