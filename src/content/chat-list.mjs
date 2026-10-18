import { cleanDisplayName, normalizeName } from "../core/normalize.mjs";

// WhatsApp Web's own markup. It is not a public API and can change, so every lookup has fallbacks
// and the caller treats "found nothing" as an expected outcome, not an error.
const PANE_SELECTOR = "#pane-side";
const ROW_SELECTOR = '[role="listitem"], [data-testid="cell-frame-container"]';
const TITLE_SELECTORS = [
  '[data-testid="cell-frame-title"] span[title]',
  'span[dir="auto"][title]',
  "span[title]",
];
const MAX_NAME_LENGTH = 100;

function nameFromRow(row) {
  for (const selector of TITLE_SELECTORS) {
    const el = row.querySelector(selector);
    const name = cleanDisplayName(el?.getAttribute("title") || el?.textContent);
    if (name) return name;
  }
  return "";
}

/** The chat names currently rendered in WhatsApp's chat list, in on-screen order, de-duplicated. */
export function readChatNames(root) {
  const pane = root.querySelector(PANE_SELECTOR);
  if (!pane) return [];

  const names = [];
  const seen = new Set();
  const add = (name) => {
    const key = normalizeName(name);
    if (!name || name.length > MAX_NAME_LENGTH || seen.has(key)) return;
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

const sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

/**
 * WhatsApp only renders the rows near the viewport, so reading the list once finds ~15 chats.
 * Scroll through the whole list, collect names at each step, then put the scroll position back.
 * Resolves { ok, reason?, names }.
 */
export async function scanChatList({ document, wait = sleep, maxSteps = 400 }) {
  const pane = document.querySelector(PANE_SELECTOR);
  if (!pane) return { ok: false, reason: "no-chat-list", names: [] };

  const found = new Map(); // normalized name -> display name, in first-seen order
  const collect = () => {
    for (const name of readChatNames(document)) {
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
