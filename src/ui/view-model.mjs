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

/** The rule, if any, that already covers a person (by name) or a chat (by chat id, else name). */
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

/** "Group" when any id is a group, "Chat" for known 1:1 ids, and honest about not knowing. */
function chatRowLabel(ids) {
  if (ids.some((id) => id.endsWith("@g.us"))) return "Group";
  return ids.length > 0 ? "Chat" : "Chat or group";
}

function toRow({ key, name, kind, kindText, targets, rules, sounds, lastSeen }) {
  // Prefer the rule bound to a chat id over a name-only one when they disagree.
  const shown = rules.find((rule) => rule.chatId) ?? rules[0] ?? null;
  return {
    key,
    name,
    kind,
    kindLabel: kindText,
    hasRule: rules.length > 0,
    linked: rules.some((rule) => rule.chatId),
    choice: shown ? ruleToChoice(shown, sounds) : CHOICE_DEFAULT,
    targets,
    lastSeen,
  };
}

/**
 * One row per chat NAME. A contact can reach us under several identities (more than one chat id,
 * or also as a person inside a group), so everything with the same name is merged into one row.
 * `targets` lists what a choice must be applied to: each known chat id, and any name-only rule.
 *
 * Sources, in display order: chats that messaged us (newest first), chats read from WhatsApp's
 * own chat list, then rules for chats we have not seen (alphabetical).
 */
export function buildChatRows(state, filterText = "") {
  const needle = normalizeName(filterText);
  const groups = new Map(); // normalized name -> group
  const group = (name, fromRule = false) => {
    const key = normalizeName(name);
    if (!groups.has(key)) {
      groups.set(key, { key, name, ids: [], rules: [], lastSeen: 0, fromRule });
    }
    return groups.get(key);
  };
  const addId = (g, id) => id && !g.ids.includes(id) && g.ids.push(id);

  for (const entry of state.recentSenders) {
    if (entry.kind !== "chat") continue;
    const g = group(entry.name);
    addId(g, entry.chatId);
    g.lastSeen = Math.max(g.lastSeen, entry.lastSeen ?? 0);
  }

  for (const chat of state.knownChats ?? []) group(chat.name);

  for (const rule of state.rules) {
    if (rule.kind !== "chat") continue;
    const byId = rule.chatId ? [...groups.values()].find((g) => g.ids.includes(rule.chatId)) : null;
    const g = byId ?? group(rule.match, true);
    addId(g, rule.chatId);
    g.rules.push(rule);
  }

  const ordered = [...groups.values()];
  const rows = ordered
    .filter((g) => !g.fromRule)
    .concat(ordered.filter((g) => g.fromRule).sort((a, b) => a.name.localeCompare(b.name)))
    .map((g) => {
      const targets = g.ids.map((id) => ({
        chatId: id,
        ruleId: g.rules.find((rule) => rule.chatId === id)?.id ?? null,
      }));
      for (const rule of g.rules) {
        if (!rule.chatId) targets.push({ chatId: null, ruleId: rule.id });
      }
      if (targets.length === 0) targets.push({ chatId: null, ruleId: null });
      return toRow({
        key: `chat|${g.key}`,
        name: g.name,
        kind: "chat",
        kindText: chatRowLabel(g.ids),
        targets,
        rules: g.rules,
        sounds: state.sounds,
        lastSeen: g.lastSeen,
      });
    });

  return rows.filter((row) => !needle || normalizeName(row.name).includes(needle));
}

/**
 * People inside groups ("Alice, in any group"). Advanced: kept out of the main list because the
 * same person usually also shows up as a chat, which is what made rows look repeated.
 */
export function buildPeopleRows(state, filterText = "") {
  const needle = normalizeName(filterText);
  const people = new Map();
  const person = (name, fromRule) => {
    const key = normalizeName(name);
    if (!people.has(key)) people.set(key, { key, name, rules: [], lastSeen: 0, fromRule });
    return people.get(key);
  };

  for (const entry of state.recentSenders) {
    if (entry.kind !== "sender") continue;
    const p = person(entry.name, false);
    p.lastSeen = Math.max(p.lastSeen, entry.lastSeen ?? 0);
  }
  for (const rule of state.rules) {
    if (rule.kind === "sender") person(rule.match, true).rules.push(rule);
  }

  const all = [...people.values()];
  return all
    .filter((p) => !p.fromRule)
    .concat(all.filter((p) => p.fromRule).sort((a, b) => a.name.localeCompare(b.name)))
    .map((p) =>
      toRow({
        key: `sender|${p.key}`,
        name: p.name,
        kind: "sender",
        kindText: kindLabel("sender"),
        targets: [{ chatId: null, ruleId: p.rules[0]?.id ?? null }],
        rules: p.rules,
        sounds: state.sounds,
        lastSeen: p.lastSeen,
      })
    )
    .filter((row) => !needle || normalizeName(row.name).includes(needle));
}
