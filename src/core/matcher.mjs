import { normalizeName } from "./normalize.mjs";
import { clampVolume, defaultSettings } from "./schema.mjs";

const MAX_SENDER_LENGTH = 64;

/**
 * Group notifications are expected to carry "Sender: message" in the body. This is a heuristic:
 * it is confirmed against real WhatsApp output in the Phase 0 probe, and returns null whenever
 * the prefix does not look like a name.
 */
export function parseSenderFromBody(body) {
  if (typeof body !== "string") return null;
  const index = body.indexOf(": ");
  if (index <= 0) return null;
  const prefix = body.slice(0, index).trim();
  if (!prefix || prefix.length > MAX_SENDER_LENGTH || prefix.includes("\n")) return null;
  return prefix;
}

/**
 * Precedence: chat rule by chat id (`notification.tag`), then chat rule by name, then sender rule.
 * A rule that has a chatId matches ONLY by id, so a different chat that happens to share the
 * display name never triggers it, and a renamed contact keeps matching.
 * Within each step the first enabled match wins.
 */
export function findRule(notification, rules) {
  if (!Array.isArray(rules)) return null;
  const enabled = rules.filter((rule) => rule && rule.enabled);

  const tag = typeof notification?.tag === "string" ? notification.tag : "";
  if (tag) {
    const byId = enabled.find((r) => r.kind === "chat" && r.chatId && r.chatId === tag);
    if (byId) return byId;
  }

  const title = normalizeName(notification?.title);
  if (title) {
    const chat = enabled.find(
      (r) => r.kind === "chat" && !r.chatId && normalizeName(r.match) === title
    );
    if (chat) return chat;
  }

  const sender = normalizeName(parseSenderFromBody(notification?.body));
  if (sender) {
    const bySender = enabled.find((r) => r.kind === "sender" && normalizeName(r.match) === sender);
    if (bySender) return bySender;
  }

  return null;
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
