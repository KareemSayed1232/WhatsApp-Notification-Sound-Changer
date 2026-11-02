import {
  cleanDisplayName,
  isCountOrTime,
  looksLikeChatName,
  normalizeName,
} from "../core/normalize.mjs";

// WhatsApp Web's own markup. It is not a public API and can change, so every lookup has fallbacks
// and the caller treats "found nothing" as an expected outcome, not an error.
// The element holding the chat list, most specific first. WhatsApp has renamed these before, so a
// few accessible-name fallbacks follow the id.
const PANE_SELECTORS = [
  "#pane-side",
  '[data-testid="chat-list"]',
  '[aria-label="Chat list"]',
  '[aria-label*="chat list" i]',
];
// Observed on WhatsApp Web (Oct 2026): rows carry data-testid="cell-frame-container" and sit in a
// role="grid" list; older builds used role="listitem". Accept any of them.
export const ROW_SELECTOR = '[role="row"], [role="listitem"], [data-testid="cell-frame-container"]';
// Pseudo-rows built from the same markup but which are not chats.
const NOT_A_CHAT = /locked chats|archived/i;
const TITLE_SELECTORS = [
  '[data-testid="cell-frame-title"] span[title]',
  'span[dir="auto"][title]',
  "span[title]",
];
const MAX_NAME_LENGTH = 100;

/** The chat list element, or null while WhatsApp has not rendered one. */
export function findChatPane(root) {
  for (const selector of PANE_SELECTORS) {
    const pane = root.querySelector(selector);
    if (pane) return pane;
  }
  return null;
}

/** The element that actually scrolls: the pane, or the nearest scrollable thing around it. */
function scrollerFor(pane) {
  for (let el = pane; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight) return el;
  }
  return pane;
}

export function isNotAChat(row) {
  const button = row.closest("button");
  // Language-independent: real chats sit in a list row; the "Archived" and "Locked chats"
  // entries are plain buttons outside any row (captured Oct 2026).
  if (button && !row.closest('[role="row"], [role="listitem"]')) return true;
  const label = `${button?.getAttribute("aria-label") ?? ""} ${button?.dataset?.testid ?? ""}`;
  return NOT_A_CHAT.test(label);
}

/** Is this element the unread badge (or inside it)? Its text is a count, never a name. */
function isBadge(el) {
  return Boolean(el.closest?.(UNREAD_SELECTOR));
}

function nameFromRow(row) {
  if (isNotAChat(row)) return "";
  const textOf = (el) => cleanDisplayName(el.getAttribute("title") || el.textContent);
  for (const selector of TITLE_SELECTORS) {
    // The first titled text that is not the unread badge, a count or a time is the name, or the
    // row has none: the message preview further on must never be taken for it.
    // The badge's label is in the UI language, but its text is always just the number.
    const el = [...row.querySelectorAll(selector)].find(
      (candidate) =>
        !isBadge(candidate) &&
        !isCountOrTime(textOf(candidate)) &&
        !/^\d+$/.test((candidate.textContent ?? "").trim())
    );
    const name = el ? textOf(el) : "";
    if (looksLikeChatName(name)) return name;
  }
  return "";
}

/** The chat names currently rendered in WhatsApp's chat list, in on-screen order, de-duplicated. */
export function readChatNames(root) {
  const pane = findChatPane(root);
  if (!pane) return [];

  const names = [];
  const seen = new Set();
  const add = (name) => {
    const key = normalizeName(name);
    if (!looksLikeChatName(name) || name.length > MAX_NAME_LENGTH || seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  const rows = pane.querySelectorAll(ROW_SELECTOR);
  if (rows.length > 0) {
    for (const row of rows) add(nameFromRow(row));
  } else {
    // The row markup changed: fall back to any title-bearing span in the list.
    for (const el of pane.querySelectorAll('span[dir="auto"][title]')) {
      add(cleanDisplayName(el.getAttribute("title")));
    }
  }
  return names;
}

// The unread counter on a chat row (captured Oct 2026: <span data-testid="icon-unread-count"
// aria-label="2 unread messages">2</span>). The label is a fallback; it is in the UI language.
export const UNREAD_SELECTOR = '[data-testid="icon-unread-count"]';
export const UNREAD_LABEL = /\bunread\b/i;
// A muted chat's row carries <… data-testid="mute-notifications-refreshed" aria-label="Muted chat">
// (captured Oct 2026). Any test id or icon mentioning "mute" counts, so a renamed marker still
// does; the English label is a last fallback.
// "unmute"/"unmuted" icons contain "mute" too, and mean the opposite.
export const MUTED_MARKER =
  '[data-testid*="mute" i]:not([data-testid*="unmute" i]), ' +
  '[data-icon*="mute" i]:not([data-icon*="unmute" i])';
export const MUTED_LABEL = '[aria-label="Muted chat" i]';
const MUTED_SELECTOR = `${MUTED_MARKER}, ${MUTED_LABEL}`;

function unreadCountOf(row) {
  const badge =
    row.querySelector(UNREAD_SELECTOR) ??
    [...row.querySelectorAll("[aria-label]")].find((el) =>
      UNREAD_LABEL.test(el.getAttribute("aria-label"))
    );
  if (!badge) return 0;
  // Only a number counts: a "marked as unread" dot is the user's doing, not a new message.
  const text = badge.textContent.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const fromLabel = /(\d+)/.exec(badge.getAttribute("aria-label") ?? "");
  return fromLabel ? Number(fromLabel[1]) : 0;
}

/**
 * Every rendered chat with its unread number and whether it is muted, keyed by normalized name:
 * Map(key -> { name, count, muted }). The Archived / Locked chats entries are left out.
 */
export function readUnreadCounts(root) {
  const counts = new Map();
  const pane = findChatPane(root);
  if (!pane) return counts;
  for (const row of pane.querySelectorAll(ROW_SELECTOR)) {
    const name = nameFromRow(row);
    if (!name || name.length > MAX_NAME_LENGTH) continue;
    const key = normalizeName(name);
    const count = unreadCountOf(row);
    const muted = row.querySelector(MUTED_SELECTOR) !== null;
    const seen = counts.get(key);
    counts.set(key, {
      name: seen?.name ?? name,
      count: Math.max(seen?.count ?? 0, count),
      muted: Boolean(seen?.muted) || muted,
    });
  }
  return counts;
}

const sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

/**
 * WhatsApp only renders the rows near the viewport, so reading the list once finds ~15 chats.
 * Scroll through the whole list, collect names at each step, then put the scroll position back.
 * Resolves { ok, reason?, names }.
 */
export async function scanChatList({
  document,
  wait = sleep,
  maxSteps = 400,
  // The content script passes its self-teaching page model (page-model.mjs) for these.
  readNames = () => readChatNames(document),
  findPane = () => findChatPane(document),
}) {
  const chatPane = findPane();
  if (!chatPane) return { ok: false, reason: "no-chat-list", names: [] };
  const pane = scrollerFor(chatPane);

  const found = new Map(); // normalized name -> display name, in first-seen order
  const collect = () => {
    for (const name of readNames()) {
      const key = normalizeName(name);
      if (!found.has(key)) found.set(key, name);
    }
  };

  const original = pane.scrollTop;
  try {
    pane.scrollTop = 0;
    await wait(150);
    collect();

    for (let step = 0; step < maxSteps; step++) {
      if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) break;
      pane.scrollTop += Math.max(120, Math.floor(pane.clientHeight * 0.8));
      await wait(120);
      collect();
    }
  } finally {
    pane.scrollTop = original;
  }

  const names = [...found.values()];
  return names.length > 0
    ? { ok: true, names }
    : { ok: false, reason: "no-chats-found", names: [] };
}
