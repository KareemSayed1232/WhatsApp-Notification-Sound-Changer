import { classifyTag } from "./health.mjs";
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
  // A colon followed by any space (including no-break spaces), or a full-width colon. "12:30"
  // and "https://" never match.
  const separator = /:\s|：/u.exec(body);
  const index = separator ? separator.index : -1;
  if (index <= 0) return null;
  const prefix = body.slice(0, index).trim();
  if (!prefix || prefix.length > MAX_SENDER_LENGTH || prefix.includes("\n")) return null;
  return prefix;
}

/**
 * Precedence: chat rule by chat id (`notification.tag`), then chat rule by name, then sender rule.
 * A rule that has a chatId matches ONLY by id, so a different chat that happens to share the
 * display name never triggers it, and a renamed contact keeps matching.
 *
 * One exception keeps rules alive when WhatsApp migrates its ids (it already moved contacts from
 * phone-number ids "...@c.us" to "...@lid"): a rule whose id is of a DIFFERENT kind than the
 * notification's still matches by name. Two ids of the same kind are always different chats.
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

    if (tag) {
      const migrated = enabled.find(
        (r) =>
          r.kind === "chat" &&
          r.chatId &&
          classifyTag(r.chatId) !== classifyTag(tag) &&
          normalizeName(r.match) === title
      );
      if (migrated) return migrated;
    }
  }

  const sender = normalizeName(parseSenderFromBody(notification?.body));
  if (sender) {
    const bySender = enabled.find((r) => r.kind === "sender" && normalizeName(r.match) === sender);
    if (bySender) return bySender;
  }

  return null;
}

/**
 * The decision for a chat known only by its name (a new message seen in the chat list, with no
 * notification and so no chat id). Chat rules tied to an id match by name here. When two chats
 * share the name, `preferChatId` (the id last seen with that name) picks which one.
 */
export function decideForChatName({ name, rules, sounds, settings, preferChatId = null }) {
  const key = normalizeName(name);
  const list = Array.isArray(rules) ? rules : [];
  const sameName = (rule) =>
    rule?.kind === "chat" && rule.chatId && normalizeName(rule.match) === key;
  const preferred =
    preferChatId && list.some((rule) => sameName(rule) && rule.chatId === preferChatId);
  const byName = list.map((rule) =>
    sameName(rule) && (!preferred || rule.chatId === preferChatId)
      ? { ...rule, chatId: null }
      : rule
  );
  return decidePlayback({
    notification: { title: name, tag: "" },
    rules: byName,
    sounds,
    settings,
  });
}

/**
 * When the rule for this notification was found through a migrated id, the rule should move onto
 * the new id: `{ ruleId, chatId }`. Otherwise null.
 */
export function findRebind(notification, rules) {
  const tag = typeof notification?.tag === "string" ? notification.tag : "";
  if (!tag) return null;
  const rule = findRule(notification, rules);
  return rule?.kind === "chat" && rule.chatId && rule.chatId !== tag
    ? { ruleId: rule.id, chatId: tag }
    : null;
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
