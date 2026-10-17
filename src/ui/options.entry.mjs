import { createSoundStore } from "../core/sound-store.mjs";
import { createStateStore } from "../core/state-store.mjs";
import { mountOptions } from "./options.mjs";

// Options page entry point; bundled to ui/options.js.
const chrome = globalThis.chrome;
const document = globalThis.document;
const soundStore = createSoundStore();
const stateStore = createStateStore({ storage: chrome.storage.local, soundStore });

mountOptions({ document, stateStore, soundStore, chrome }).catch((error) => {
  document.getElementById("app").textContent = `Could not load settings: ${error.message}`;
});
