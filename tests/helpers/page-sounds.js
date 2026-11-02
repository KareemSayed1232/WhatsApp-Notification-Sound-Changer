import { EVENT_SOUNDS } from "../../src/core/protocol.mjs";

// The page hook plays your sounds itself, in a player WhatsApp's page creates, from sounds the
// bridge hands it in advance. Tests that only care WHICH sound was chosen give the hook a page
// player and a few sounds, then watch the hook's "played your sound" notice (EVENT_PLAY).

/** Sound ids used across the hook tests. */
export const TEST_SOUND_IDS = ["s1", "s2", "d", "chat", "default", "radwa"];

/** Every page player the hook started for one of your sounds: { src, volume }. */
export const pagePlays = [];

export function withPageSounds(win, doc, ids = TEST_SOUND_IDS) {
  pagePlays.length = 0;
  let next = 0;
  win.Blob = win.Blob ?? globalThis.Blob;
  win.URL = win.URL ?? { createObjectURL: () => `blob:test-${++next}`, revokeObjectURL: () => {} };
  win.Audio =
    win.Audio ??
    class PageAudio {
      constructor(src) {
        this.src = src;
        this.volume = 1;
      }
      play() {
        pagePlays.push({ src: this.src, volume: this.volume });
        return Promise.resolve();
      }
    };
  const sounds = ids.map((id) => ({ id, dataUrl: `data:audio/mpeg;base64,${btoa(id)}` }));
  doc.dispatchEvent(new CustomEvent(EVENT_SOUNDS, { detail: JSON.stringify({ sounds }) }));
}
