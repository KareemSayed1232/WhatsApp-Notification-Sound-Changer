import { classifyTag } from "./health.mjs";
import { parseSenderFromBody } from "./matcher.mjs";
import { cleanDisplayName, normalizeName } from "./normalize.mjs";

// How many different chat ids sharing one notification title mean the titles are no longer chat
// names (two real chats can share a name; three is the sign).
const GENERIC_TITLE_IDS = 3;
// A chat showing this many different senders is a group.
const GROUP_SENDERS = 2;
const MAX_TRACKED = 300;
const MAX_PER_ENTRY = 5;

function addCapped(map, key, value) {
  if (!map.has(key)) {
    if (map.size >= MAX_TRACKED) map.delete(map.keys().next().value);
    map.set(key, new Set());
  }
  const set = map.get(key);
  if (set.size < MAX_PER_ENTRY) set.add(value);
  return set;
}

/**
 * What kind of chat each notification comes from, judged by behaviour rather than by WhatsApp's
 * id format alone, and whether WhatsApp still follows the shapes the extension relies on:
 *
 *  - a group: its id ends in "@g.us" (today), or its messages arrive from different senders;
 *  - "titles generic": one notification title arriving for several different chat ids, i.e. the
 *    title no longer names the chat;
 *  - "sender missing": group messages in a row with no "Sender: text" part.
 *
 * Kept in memory for the session (sender names never leave it). `groups` seeds chat ids already
 * known to be groups (saved earlier).
 */
export function createChatIdentity({ groups = [] } = {}) {
  const knownGroups = new Set(groups.filter((id) => typeof id === "string" && id));
  const sendersByTag = new Map();
  const tagsByTitle = new Map();
  let titlesGeneric = false;
  let senderMissRun = 0;

  return {
    observe({ title, tag, body } = {}) {
      const chatId = typeof tag === "string" ? tag : "";
      const titleKey = normalizeName(cleanDisplayName(typeof title === "string" ? title : ""));
      const sender = cleanDisplayName(parseSenderFromBody(body) ?? "");
      const senderKey = normalizeName(sender);

      if (chatId && titleKey) {
        if (addCapped(tagsByTitle, titleKey, chatId).size >= GENERIC_TITLE_IDS) {
          titlesGeneric = true;
        }
      }

      let newlyGroup = false;
      if (chatId && senderKey && senderKey !== titleKey) {
        const senders = addCapped(sendersByTag, chatId, senderKey);
        if (senders.size >= GROUP_SENDERS && !knownGroups.has(chatId)) {
          knownGroups.add(chatId);
          newlyGroup = true;
        }
      }

      const isGroup =
        Boolean(chatId) && (classifyTag(chatId) === "group" || knownGroups.has(chatId));
      if (isGroup) senderMissRun = sender ? 0 : senderMissRun + 1;

      return { isGroup, newlyGroup, sender, titlesGeneric, senderMissRun };
    },

    isGroup(tag) {
      return typeof tag === "string" && (classifyTag(tag) === "group" || knownGroups.has(tag));
    },
  };
}
