import { normalizeName } from "../core/normalize.mjs";
import { STRINGS as S } from "./strings.mjs";

export const CHOICE_DEFAULT = "__default";
export const CHOICE_SILENT = "__silent";

export function formatBytes(bytes) {
  if (!(bytes > 0)) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Group" for WhatsApp group ids, "Person in a group" for sender rules, otherwise "Chat". */
export function kindLabel(kind, chatId) {
  if (kind === "sender") return "Person in a group";
  return typeof chatId === "string" && chatId.endsWith("@g.us") ? "Group" : "Chat";
}

/** The value a rule's sound <select> should show. */
export function ruleToChoice(rule, sounds) {
  if (rule.action === "silent") return CHOICE_SILENT;
  if (rule.action === "sound" && sounds[rule.soundId]) return rule.soundId;
  return CHOICE_DEFAULT;
}

/** Inverse of ruleToChoice: the rule fields a <select> value stands for. */
export function choiceToAction(choice) {
  if (choice === CHOICE_SILENT) return { action: "silent", soundId: null };
  if (choice === CHOICE_DEFAULT || !choice) return { action: "default", soundId: null };
  return { action: "sound", soundId: choice };
}

const byCreated = (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.name.localeCompare(b.name);

/** Options for any "which sound?" dropdown. */
export function soundChoices(sounds) {
  return [
    { value: CHOICE_DEFAULT, label: S.choiceDefault },
    { value: CHOICE_SILENT, label: S.choiceSilent },
    ...Object.values(sounds)
      .sort(byCreated)
      .map((sound) => ({ value: sound.id, label: sound.name })),
  ];
}

/** What the default-sound dropdown means right now, so "None" is never a mystery. */
export function defaultSoundHint(state) {
  const id = state.settings.defaultSoundId;
  return id && state.sounds[id] ? S.defaultSoundHint : S.defaultHintOff;
}

export function buildSoundRows(state) {
  return Object.values(state.sounds)
    .sort(byCreated)
    .map((sound) => ({
      id: sound.id,
      name: sound.name,
      sizeLabel: formatBytes(sound.size),
      isDefault: state.settings.defaultSoundId === sound.id,
      usedBy: state.rules.filter((rule) => rule.action === "sound" && rule.soundId === sound.id)
        .length,
    }));
}

export function buildRuleRows(state, filterText = "") {
  const needle = normalizeName(filterText);
  return state.rules
    .map((rule) => ({
      id: rule.id,
      label: rule.match,
      kind: rule.kind,
      kindLabel: kindLabel(rule.kind, rule.chatId),
      linked: Boolean(rule.chatId),
      enabled: rule.enabled !== false,
      choice: ruleToChoice(rule, state.sounds),
    }))
    .filter((row) => !needle || normalizeName(row.label).includes(needle))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Does an existing rule already cover this recently seen chat or person? */
function isCovered(entry, rules) {
  const name = normalizeName(entry.name);
  return rules.some((rule) => {
    if (rule.kind !== entry.kind) return false;
    if (entry.chatId && rule.chatId) return rule.chatId === entry.chatId;
    return !rule.chatId && normalizeName(rule.match) === name;
  });
}

/** Recently seen chats/people that do not have a rule yet, newest first. */
export function recentChoices(state, limit = 50) {
  return state.recentSenders
    .filter((entry) => !isCovered(entry, state.rules))
    .slice(0, limit)
    .map((entry) => ({
      key: `${entry.kind}|${entry.chatId || normalizeName(entry.name)}`,
      name: entry.name,
      kind: entry.kind,
      chatId: entry.chatId ?? null,
      kindLabel: kindLabel(entry.kind, entry.chatId),
      lastSeen: entry.lastSeen,
    }));
}
