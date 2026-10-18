import { normalizeName } from "../core/normalize.mjs";

const WINDOW_MS = 2000;
const MAX_CHATS = 500;
const MAX_KEY_LENGTH = 100;

/** A stored { chatKey: boolean } map, checked. */
export function sanitizeMuted(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_CHATS)) {
    if (typeof value === "boolean" && key && key.length <= MAX_KEY_LENGTH) clean[key] = value;
  }
  return clean;
}

/**
 * Which chats are muted, learned from what WhatsApp DOES rather than how it draws it: WhatsApp
 * raises no notification for a muted chat. So, while the tab is in the background, a chat whose
 * unread counter rises with no notification for it within a couple of seconds is muted, and a
 * chat that gets a notification is not. Works in any language and survives any markup change.
 *
 * `canLearn()` must say whether notifications are flowing at all (if they are not, every chat
 * would look muted). `onChange(snapshot)` is told about every real change, for saving.
 */
export function createMuteLearner({
  now = () => Date.now(),
  setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
  windowMs = WINDOW_MS,
  initial = {},
  canLearn = () => true,
  onChange = () => {},
}) {
  const muted = new Map(Object.entries(sanitizeMuted(initial)));
  const notifiedAt = new Map();
  const timers = new Set();
  let stopped = false;

  const keyOf = (name) => normalizeName(typeof name === "string" ? name : "");
  const snapshot = () => Object.fromEntries(muted);

  function set(key, value) {
    if (!key || muted.get(key) === value) return;
    if (!muted.has(key) && muted.size >= MAX_CHATS) muted.delete(muted.keys().next().value);
    muted.set(key, value);
    onChange(snapshot());
  }

  return {
    /** WhatsApp raised a notification for this chat: it is not muted. */
    noteNotification(name) {
      const key = keyOf(name);
      if (!key || stopped) return;
      notifiedAt.set(key, now());
      set(key, false);
    },

    /** This chat's unread counter rose while the tab was in the background. */
    noteBackgroundRise(name) {
      const key = keyOf(name);
      if (!key || stopped || !canLearn()) return;
      const at = now();
      const timer = setTimeoutFn(() => {
        timers.delete(timer);
        if (stopped || !canLearn()) return;
        const notified = notifiedAt.get(key);
        if (notified !== undefined && Math.abs(notified - at) <= windowMs) return;
        set(key, true);
      }, windowMs + 50);
      timers.add(timer);
    },

    /** true / false when learned, undefined when not known yet. */
    isMuted(name) {
      return muted.get(keyOf(name));
    },

    snapshot,

    stop() {
      stopped = true;
      for (const timer of timers) clearTimeoutFn(timer);
      timers.clear();
    },
  };
}
