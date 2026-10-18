import { createAudioEngine } from "./audio-engine.mjs";
import { createSoundLoader, startBridge } from "./bridge.mjs";

// Content script (isolated world) entry point; bundled to content/bridge.js.
const chrome = globalThis.chrome;
const document = globalThis.document;

const engine = createAudioEngine({
  AudioContextCtor: globalThis.AudioContext || globalThis.webkitAudioContext,
  loadSound: createSoundLoader(chrome),
  onError: (error) => globalThis.console.debug("[WANSC]", error.message),
});

/** Opt-in tracing: run `localStorage.wanscDebug = "1"` in the page console, then reload. */
function log(...args) {
  try {
    if (globalThis.localStorage?.getItem("wanscDebug"))
      globalThis.console.debug("[WANSC]", ...args);
  } catch {
    // Best-effort only.
  }
}

engine.armUnlock(document);
startBridge({ chrome, document, engine, log });
