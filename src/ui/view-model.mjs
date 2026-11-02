import { normalizeName } from "../core/normalize.mjs";
import { STRINGS as S } from "./strings.mjs";

export const CHOICE_DEFAULT = "__default";
export const CHOICE_SILENT = "__silent";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago". */
export function formatAgo(ms) {
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (ms < MINUTE) return S.justNow;
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return plural(Math.floor(ms / HOUR), "hour");
  return plural(Math.floor(ms / DAY), "day");
}

export function formatBytes(bytes) {
  if (!(bytes > 0)) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Group" for WhatsApp group ids, otherwise "Chat". */
export function kindLabel(kind, chatId) {
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

/** Options for any "which sound?" dropdown: default, silent, then every loaded sound. */
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

/** "Group" when the chat is known to be one (by behaviour or by its id), "Chat" otherwise. */
function chatRowLabel(ids, isGroup) {
  if (isGroup || ids.some((id) => id.endsWith("@g.us"))) return "Group";
  return ids.length > 0 ? "Chat" : "Chat or group";
}

function toRow({ key, name, kind, kindText, targets, rules, sounds, lastSeen }) {
  // Prefer the rule bound to a chat id over a name-only one when they disagree.
  const shown = rules.find((rule) => rule.chatId) ?? rules[0] ?? null;
  const choice = shown ? ruleToChoice(shown, sounds) : CHOICE_DEFAULT;
  return {
    key,
    name,
    kind,
    kindLabel: kindText,
    // A rule that resolves to "Default sound" (e.g. its sound was deleted) is no custom setting.
    hasRule: rules.some((rule) => ruleToChoice(rule, sounds) !== CHOICE_DEFAULT),
    linked: rules.some((rule) => rule.chatId),
    choice,
    targets,
    lastSeen,
  };
}

// A phone-number chat id. WhatsApp moved contacts from these to "@lid" ids, so the same person can
// appear under both: they are one chat, not two.
const PHONE_ID = /@(c.us|s.whatsapp.net)$/;

/**
 * The real chats behind one name: each group is its own chat, and so is each person, except that
 * a person's old phone-number id joins their newest id (the same contact, migrated). Returns a list
 * of id lists; one entry means the name is a single chat.
 */
function chatsUnder(g) {
  const isGroupId = (id) => id.endsWith("@g.us") || g.idSeen.get(id)?.group === true;
  const seenAt = (id) => g.idSeen.get(id)?.lastSeen ?? 0;
  const groupIds = g.ids.filter(isGroupId);
  const people = g.ids.filter((id) => !isGroupId(id));
  const current = people.filter((id) => !PHONE_ID.test(id));
  const phone = people.filter((id) => PHONE_ID.test(id));
  let personChats;
  if (current.length === 0) {
    personChats = phone.map((id) => [id]);
  } else {
    personChats = current.map((id) => [id]);
    const newest = personChats.reduce((a, b) => (seenAt(b[0]) > seenAt(a[0]) ? b : a));
    newest.push(...phone);
  }
  return [...groupIds.map((id) => [id]), ...personChats];
}

function lastMessageText(lastSeen, now) {
  return lastSeen > 0
    ? `${S.lastMessage} ${formatAgo(Math.max(0, now - lastSeen))}`
    : S.noMessageYet;
}

/**
 * Several chats share this name: one row each, newest first, told apart by when each last
 * messaged. A sound set earlier for the NAME (no chat id) still shows in every row until that
 * chat gets its own; `siblings` and `sharedRuleIds` let a choice in one row leave the others
 * alone (see applyChoice).
 */
function splitRows(g, clusters, sounds, now) {
  const nameRules = g.rules.filter((rule) => !rule.chatId);
  const chats = clusters
    .map((ids) => {
      const idRules = g.rules.filter((rule) => rule.chatId && ids.includes(rule.chatId));
      return {
        ids,
        idRules,
        isGroup: ids.some((id) => id.endsWith("@g.us") || g.idSeen.get(id)?.group === true),
        lastSeen: Math.max(0, ...ids.map((id) => g.idSeen.get(id)?.lastSeen ?? 0)),
        targets: ids.map((id) => ({
          chatId: id,
          ruleId: idRules.find((rule) => rule.chatId === id)?.id ?? null,
        })),
      };
    })
    .sort((a, b) => b.lastSeen - a.lastSeen);

  return chats.map((chat) => ({
    ...toRow({
      key: `chat|${g.key}|${chat.ids[0]}`,
      name: g.name,
      kind: "chat",
      kindText: `${chatRowLabel(chat.ids, chat.isGroup)} · ${lastMessageText(chat.lastSeen, now)}`,
      targets: chat.targets,
      rules: chat.idRules.length > 0 ? chat.idRules : nameRules,
      sounds,
      lastSeen: chat.lastSeen,
    }),
    siblings: chats.filter((other) => other !== chat).flatMap((other) => other.targets),
    sharedRuleIds: nameRules.map((rule) => rule.id),
  }));
}

/**
 * One row per chat NAME. A contact can reach us under several identities (more than one chat id,
 * or also as a person inside a group), so everything with the same name is merged into one row.
 * `targets` lists what a choice must be applied to: each known chat id, and any name-only rule.
 *
 * Sources, in display order: chats that messaged us (newest first), chats read from WhatsApp's
 * own chat list, then rules for chats we have not seen (alphabetical).
 */
export function buildChatRows(state, filterText = "", now = Date.now()) {
  const needle = normalizeName(filterText);
  const groups = new Map(); // normalized name -> group
  const group = (name, fromRule = false) => {
    const key = normalizeName(name);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name,
        ids: [],
        rules: [],
        lastSeen: 0,
        fromRule,
        isGroup: false,
        idSeen: new Map(), // chat id -> { lastSeen, group }
      });
    }
    return groups.get(key);
  };
  const addId = (g, id) => id && !g.ids.includes(id) && g.ids.push(id);

  for (const entry of state.recentSenders) {
    if (entry.kind !== "chat") continue;
    const g = group(entry.name);
    addId(g, entry.chatId);
    if (entry.group === true) g.isGroup = true;
    if (entry.chatId) {
      const before = g.idSeen.get(entry.chatId);
      g.idSeen.set(entry.chatId, {
        lastSeen: Math.max(before?.lastSeen ?? 0, entry.lastSeen ?? 0),
        group: before?.group === true || entry.group === true,
      });
    }
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
    .flatMap((g) => {
      const clusters = chatsUnder(g);
      if (clusters.length > 1) return splitRows(g, clusters, state.sounds, now);
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
        kindText: chatRowLabel(g.ids, g.isGroup),
        targets,
        rules: g.rules,
        sounds: state.sounds,
        lastSeen: g.lastSeen,
      });
    });

  return rows.filter((row) => !needle || normalizeName(row.name).includes(needle));
}

export const MAX_SHOWN = 25;

/**
 * What to display: with an empty search, only the chats that already have a sound of their own
 * (so a long WhatsApp chat list never floods the screen); with a search, the matching chats.
 * `more` is how many matches were cut off by `limit`.
 */
export function chatsToShow(rows, query, limit = MAX_SHOWN) {
  const needle = normalizeName(query);
  if (!needle) return { rows: rows.filter((row) => row.hasRule), more: 0, searching: false };
  const matches = rows.filter((row) => normalizeName(row.name).includes(needle));
  return {
    rows: matches.slice(0, limit),
    more: Math.max(0, matches.length - limit),
    searching: true,
  };
}
