import { fillSelect, h } from "./dom.mjs";
import { icon } from "./icons.mjs";
import { STRINGS as S, errorMessage } from "./strings.mjs";
import { buildSoundRows, choiceToAction, recentChoices, soundChoices } from "./view-model.mjs";

const RECENT_LIMIT = 5;

/** The compact toolbar popup: on/off, volume, and one-tap sounds for chats that just messaged. */
export async function mountPopup({ document, stateStore, chrome }) {
  const el = (tag, props, ...kids) => h(document, tag, props, ...kids);
  let state = await stateStore.load();
  let toastTimer = null;
  const win = document.defaultView;
  const percent = (value) => `${Math.round(Number(value) * 100)}%`;

  const enabled = el("input", {
    type: "checkbox",
    role: "switch",
    id: "enabled",
    onChange: onEnabled,
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
  const recentList = el("ul", { id: "recentList", class: "recent-list" });
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
      "div",
      { class: "field" },
      el("label", { for: "volume" }, S.volume),
      el("div", { class: "range-row" }, volume, volumeOut)
    ),
    el("h2", {}, S.popupRecent),
    recentList,
    recentEmpty,
    el(
      "button",
      {
        class: "btn btn-primary btn-block",
        id: "openSettings",
        type: "button",
        onClick: openSettings,
      },
      icon(document, "settings"),
      S.popupOpenSettings
    )
  );
  document.getElementById("app").replaceChildren(page);

  function say(text, kind = "ok") {
    message.textContent = text;
    message.className = `toast toast-${kind}`;
    message.hidden = false;
    win.clearTimeout(toastTimer);
    toastTimer = win.setTimeout(() => (message.hidden = true), 3000);
  }

  function renderRecent() {
    const choices = recentChoices(state, RECENT_LIMIT);
    recentEmpty.hidden = choices.length > 0;
    recentList.replaceChildren(
      ...choices.map((choice) => {
        const select = el("select", {
          class: "select",
          "aria-label": `${S.soundLabel}: ${choice.name}`,
          onChange: (event) => assign(choice, event.target.value),
        });
        fillSelect(
          document,
          select,
          [{ value: "", label: S.chooseSound }, ...soundChoices(state.sounds)],
          ""
        );
        return el(
          "li",
          { dataset: { key: choice.key } },
          el(
            "div",
            { class: "recent-name" },
            el("span", { class: "name" }, choice.name),
            el("span", { class: "meta" }, choice.kindLabel)
          ),
          select
        );
      })
    );
  }

  function render() {
    enabled.checked = state.settings.enabled;
    volume.value = String(state.settings.volume);
    volumeOut.textContent = percent(state.settings.volume);
    needSound.hidden = buildSoundRows(state).length > 0;
    renderRecent();
  }

  async function save(task, success) {
    try {
      await task();
      if (success) say(success);
    } catch (error) {
      say(errorMessage(error), "error");
    }
    state = await stateStore.load();
    render();
  }

  function onEnabled() {
    save(() => stateStore.setSettings({ enabled: enabled.checked }));
  }

  function onVolume() {
    save(() => stateStore.setSettings({ volume: Number(volume.value) }));
  }

  function assign(choice, value) {
    if (!value) return; // the "Choose a sound…" placeholder
    save(
      () =>
        stateStore.addRule({
          kind: choice.kind,
          match: choice.name,
          chatId: choice.kind === "chat" ? choice.chatId : null,
          ...choiceToAction(value),
        }),
      `${S.saved}`
    );
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
