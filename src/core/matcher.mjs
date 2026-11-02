import { normalizeName } from "./normalize.mjs";
import { clampVolume, defaultSettings } from "./schema.mjs";

/**
 * The rule for a notification. A rule tied to a chat id matches ONLY that id: a different chat
 * that happens to share the name never triggers it, and a renamed contact keeps matching. A rule
 * not yet tied to an id (made from a name, e.g. from "Refresh chat list") matches the exact name,
 * until the chat's first notification ties it to the chat's id (see findRebind).
 */
export function findRule(notification, rules) {
  if (!Array.isArray(rules)) return null;
  const enabled = rules.filter((rule) => rule && rule.enabled && rule.kind === "chat");

  const tag = typeof notification?.tag === "string" ? notification.tag : "";
  if (tag) {
    const byId = enabled.find((r) => r.chatId && r.chatId === tag);
    if (byId) return byId;
  }

  const title = normalizeName(notification?.title);
  if (title) {
    const byName = enabled.find((r) => !r.chatId && normalizeName(r.match) === title);
    if (byName) return byName;
  }
  return null;
}

/**
 * A rule made from a name that this notification matched by name: tie it to the chat's id,
 * `{ ruleId, chatId }`, so from now on it matches that chat only. Otherwise null.
 */
export function findRebind(notification, rules) {
  const tag = typeof notification?.tag === "string" ? notification.tag : "";
  if (!tag) return null;
  const rule = findRule(notification, rules);
  return rule && !rule.chatId ? { ruleId: rule.id, chatId: tag } : null;
}

/**
 * Decide what to do for one notification.
 *  - { action: "native" }               leave WhatsApp's own sound untouched
 *  - { action: "silent", ruleId }       suppress every sound
 *  - { action: "play", soundId, volume, ruleId }
 */
export function decidePlayback({ notification, rules, sounds, settings }) {
  const config = { ...defaultSettings(), ...settings };
  if (config.enabled === false) return { action: "native" };

  const volume = clampVolume(config.volume);
  const knownSounds = sounds ?? {};
  const rule = findRule(notification, rules);

  if (rule?.action === "silent") return { action: "silent", ruleId: rule.id };

  if (rule?.action === "sound" && knownSounds[rule.soundId]) {
    return { action: "play", soundId: rule.soundId, volume, ruleId: rule.id };
  }

  if (config.defaultSoundId && knownSounds[config.defaultSoundId]) {
    return { action: "play", soundId: config.defaultSoundId, volume, ruleId: rule?.id ?? null };
  }

  return { action: "native" };
}
