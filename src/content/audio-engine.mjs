import { clampVolume } from "../core/schema.mjs";

const RESUME_TIMEOUT_MS = 300;
const GESTURE_EVENTS = ["pointerdown", "keydown", "click"];

const defaultDelay = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

/**
 * Plays the user's sounds through Web Audio. Decoding bytes with decodeAudioData avoids loading
 * a media URL, so WhatsApp's content-security-policy cannot block it the way it could block an
 * <audio src="data:..."> element.
 */
export function createAudioEngine({
  AudioContextCtor,
  loadSound,
  onError = () => {},
  delay = defaultDelay,
}) {
  let context = null;
  let current = null;
  const decoded = new Map(); // soundId -> Promise<AudioBuffer | null>

  function getContext() {
    if (!context) context = new AudioContextCtor();
    return context;
  }

  function decode(soundId) {
    if (!decoded.has(soundId)) {
      const promise = (async () => {
        const sound = await loadSound(soundId);
        if (!sound) return null;
        const { bytes } = sound;
        // decodeAudioData detaches the buffer it is given, so hand it a copy.
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        return getContext().decodeAudioData(copy);
      })();
      decoded.set(soundId, promise);
      promise.catch(() => decoded.delete(soundId)); // a failure must not be cached
    }
    return decoded.get(soundId);
  }

  function stop() {
    if (!current) return;
    try {
      current.stop();
    } catch {
      // Already stopped.
    }
    current = null;
  }

  async function ensureRunning(ctx) {
    if (ctx.state === "running") return true;
    // Without a user gesture the browser may keep resume() pending forever, so do not wait on it.
    await Promise.race([Promise.resolve(ctx.resume()).catch(() => {}), delay(RESUME_TIMEOUT_MS)]);
    return ctx.state === "running";
  }

  return {
    /** Resolves true if the sound started playing. Never rejects. */
    async play(soundId, volume = 1) {
      try {
        const ctx = getContext();
        if (!(await ensureRunning(ctx))) {
          throw new Error("Audio is blocked until you interact with the WhatsApp page");
        }
        const buffer = await decode(soundId);
        if (!buffer) throw new Error(`Sound ${soundId} is not available`);

        stop();
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        gain.gain.value = clampVolume(volume);
        source.buffer = buffer;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.onended = () => {
          if (current === source) current = null;
        };
        current = source;
        source.start();
        return true;
      } catch (error) {
        onError(error);
        return false;
      }
    },

    /** Forget decoded audio, for one sound or all of them (the stored bytes changed). */
    invalidate(soundId) {
      if (soundId === undefined) decoded.clear();
      else decoded.delete(soundId);
    },

    /** Browsers only start audio after a user gesture: resume on the first one we see. */
    armUnlock(target) {
      const unlock = () => {
        for (const name of GESTURE_EVENTS) target.removeEventListener(name, unlock, true);
        const ctx = getContext();
        if (ctx.state !== "running") Promise.resolve(ctx.resume()).catch(() => {});
      };
      for (const name of GESTURE_EVENTS) target.addEventListener(name, unlock, true);
    },
  };
}
