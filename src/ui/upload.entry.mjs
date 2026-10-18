import { createSoundStore } from "../core/sound-store.mjs";
import { createStateStore } from "../core/state-store.mjs";
import { mountUpload } from "./upload.mjs";

// Small upload window entry point; bundled to ui/upload.js.
const chrome = globalThis.chrome;
const document = globalThis.document;
const soundStore = createSoundStore();
const stateStore = createStateStore({ storage: chrome.storage.local, soundStore });

mountUpload({ document, stateStore }).catch((error) => {
  document.getElementById("app").textContent = `Could not load: ${error.message}`;
});
