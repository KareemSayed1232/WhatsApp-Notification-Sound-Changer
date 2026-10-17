import { createSoundStore } from "../core/sound-store.mjs";
import { createStateStore } from "../core/state-store.mjs";
import { mountPopup } from "./popup.mjs";

// Toolbar popup entry point; bundled to ui/popup.js.
const chrome = globalThis.chrome;
const document = globalThis.document;
const soundStore = createSoundStore();
const stateStore = createStateStore({ storage: chrome.storage.local, soundStore });

mountPopup({ document, stateStore, chrome }).catch((error) => {
  document.getElementById("app").textContent = `Could not load: ${error.message}`;
});
