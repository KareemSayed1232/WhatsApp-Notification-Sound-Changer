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

engine.armUnlock(document);
startBridge({ chrome, document, engine });
