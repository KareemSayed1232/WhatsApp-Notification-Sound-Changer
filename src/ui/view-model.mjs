import { normalizeName } from "../core/normalize.mjs";
import { STRINGS as S } from "./strings.mjs";

export const CHOICE_DEFAULT = "__default";
export const CHOICE_SILENT = "__silent";
export const CHOICE_UPLOAD = "__upload";

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

/**
 * Options for any "which sound?" dropdown. With `allowUpload`, a last option lets the user add a
 * new sound without leaving the dropdown.
 */
export function soundChoices(sounds, { allowUpload = false } = {}) {
  return [
    { value: CHOICE_DEFAULT, label: S.choiceDefault },
    { value: CHOICE_SILENT, label: S.choiceSilent },
    ...Object.values(sounds)
      .sort(byCreated)
      .map((sound) => ({ value: sound.id, label: sound.name })),
    ...(allowUpload ? [{ value: CHOICE_UPLOAD, label: S.choiceUpload }] : []),
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

/** The rule, if any, that already covers a chat or a person (by chat id, else by name). */
export function ruleFor(entry, rules) {
  const name = normalizeName(entry.name);
  return (
    rules.find((rule) => {
      if (rule.kind !== entry.kind) return false;
      if (entry.chatId && rule.chatId) return rule.chatId === entry.chatId;
      return !rule.chatId && normalizeName(rule.match) === name;
    }) ?? null
  );
}

function makeRow({ name, kind, chatId, rule, sounds, lastSeen }) {
  return {
    key: `${kind}|${chatId || normalizeName(name)}`,
    name,
    kind,
    kindLabel: kindLabel(kind, chatId),
    chatId: chatId ?? null,
    ruleId: rule?.id ?? null,
    hasRule: Boolean(rule),
    choice: rule ? ruleToChoice(rule, sounds) : CHOICE_DEFAULT,
    lastSeen: lastSeen ?? 0,
  };
}

/**
 * The single list the user works with: every chat or person we have seen (newest first), each
 * showing the sound it has now, followed by any rules for chats we have not seen yet.
 */
export function buildChatRows(state, filterText = "") {
  const needle = normalizeName(filterText);
  const covered = new Set();
  const rows = [];

  for (const entry of state.recentSenders) {
    const rule = ruleFor(entry, state.rules);
    if (rule) covered.add(rule.id);
    rows.push(
      makeRow({
        name: entry.name,
        kind: entry.kind,
        chatId: entry.chatId,
        rule,
        sounds: state.sounds,
        lastSeen: entry.lastSeen,
      })
    );
  }

  const unseen = state.rules
    .filter((rule) => !covered.has(rule.id))
    .map((rule) =>
      makeRow({
        name: rule.match,
        kind: rule.kind,
        chatId: rule.chatId,
        rule,
        sounds: state.sounds,
      })
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...rows, ...unseen].filter((row) => !needle || normalizeName(row.name).includes(needle));
}
