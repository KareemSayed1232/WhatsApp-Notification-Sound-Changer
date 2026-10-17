import { createSoundStore } from "../core/sound-store.mjs";
import { createStateStore } from "../core/state-store.mjs";
import { startBackground } from "./background.mjs";

// Background entry point (service worker in Chrome, event page in Firefox); bundled to background.js.
const chrome = globalThis.chrome;
const soundStore = createSoundStore();
const stateStore = createStateStore({ storage: chrome.storage.local, soundStore });

startBackground({ chrome, stateStore, soundStore });
