import { applyChoice } from "./chat-actions.mjs";
import { h } from "./dom.mjs";
import { icon } from "./icons.mjs";
import { STRINGS as S, errorMessage } from "./strings.mjs";
import { buildChatRows } from "./view-model.mjs";

/**
 * A tiny window for uploading one sound for one chat. The toolbar popup opens it where the browser
 * would close the popup the moment a file picker opens (Firefox, Safari). A window is not closed
 * by a file picker, so the upload always completes.
 *
 * The chat comes from the URL (`?chat=<row key>`), so nothing personal is kept anywhere else.
 */
export async function mountUpload({ document, stateStore, search, closeAfterMs = 1600 }) {
  const win = document.defaultView;
  const el = (tag, props, ...kids) => h(document, tag, props, ...kids);
  const key = new win.URLSearchParams(search ?? win.location.search).get("chat");

  const state = await stateStore.load();
  const row = key ? buildChatRows(state).find((r) => r.key === key) : null;

  const status = el("p", {
    class: "toast",
    id: "status",
    role: "status",
    "aria-live": "polite",
    hidden: true,
  });
  const say = (text, kind = "ok") => {
    status.textContent = text;
    status.className = `toast toast-${kind}`;
    status.hidden = false;
  };

  const fileInput = el("input", {
    id: "soundFile",
    type: "file",
    accept: "audio/*",
    class: "visually-hidden",
    onChange: onFile,
  });
  const chooseButton = el(
    "label",
    { class: "btn btn-primary btn-large", for: "soundFile", id: "chooseFile" },
    icon(document, "upload", 20),
    S.chooseFile
  );

  const page = el(
    "div",
    { class: "upload-page" },
    el(
      "header",
      { class: "brand" },
      el("span", { class: "brand-mark" }, icon(document, "bell", 20)),
      el("h1", {}, S.uploadTitle)
    ),
    row
      ? el(
          "div",
          { class: "upload-body" },
          el(
            "p",
            { class: "upload-for" },
            S.uploadForLabel,
            " ",
            el("strong", { id: "uploadName" }, row.name)
          ),
          el("p", { class: "hint" }, S.uploadHint),
          chooseButton,
          fileInput
        )
      : el("p", { class: "toast toast-error", id: "noChat" }, S.uploadNoChat),
    status
  );
  document.getElementById("app").replaceChildren(page);

  async function onFile() {
    const file = fileInput.files?.[0];
    if (!file || !row) return;
    say(`${S.uploading} "${file.name}"…`); // proof the file arrived, before anything can fail
    try {
      const fresh = await stateStore.load();
      const current = buildChatRows(fresh).find((r) => r.key === key) ?? row;
      const sound = await stateStore.addSound(file);
      await applyChoice(stateStore, current, sound.id);
      say(`Added "${file.name}" for ${row.name}. ${S.uploadClosing}`);
      win.setTimeout(() => win.close(), closeAfterMs);
    } catch (error) {
      say(errorMessage(error), "error");
    }
    fileInput.value = "";
  }
}
