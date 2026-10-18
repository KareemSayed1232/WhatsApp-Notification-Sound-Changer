import { cleanDisplayName, normalizeName } from "../core/normalize.mjs";
import {
  MUTED_LABEL,
  MUTED_MARKER,
  ROW_SELECTOR,
  UNREAD_LABEL,
  UNREAD_SELECTOR,
  isNotAChat,
} from "./chat-list.mjs";
import {
  findByFingerprint,
  fingerprintOf,
  sameFingerprint,
  sanitizeFingerprint,
} from "./fingerprint.mjs";

// Where the extension keeps what it learned about WhatsApp's page (fingerprints, mutes).
export { PAGE_MODEL_KEY } from "../core/protocol.mjs";

// WhatsApp's own names, today (captured Oct 2026). Used after what was learned and, for the
// English labels, only after page structure has had its say.
const STRONG_PANES = ["#pane-side", '[data-testid="chat-list"]'];
const LABEL_PANES = ['[aria-label="Chat list"]', '[aria-label*="chat list" i]'];
const STRONG_TITLES = ['[data-testid="cell-frame-title"] span[title]'];
const LOOSE_TITLES = ['span[dir="auto"][title]', "span[title]"];
const DIGITS = /^\d{1,4}$/;
const MAX_NAME_LENGTH = 100;
// A fingerprint is trusted once this many notifications in a row agree on it.
const CONFIRMATIONS = 2;
const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING

export function sanitizeLearned(raw) {
  return {
    name: sanitizeFingerprint(raw?.name),
    counter: sanitizeFingerprint(raw?.counter),
  };
}

const textOf = (el) =>
  el ? cleanDisplayName(el.getAttribute?.("title") || el.textContent || "") : "";

function first(root, selectors) {
  for (const selector of selectors) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

function depthOf(node) {
  let level = 0;
  for (let n = node; n; n = n.parentElement) level += 1;
  return level;
}

/** The leaf-most elements under `root` whose text (or title) is one of `names`. */
function knownNameElements(root, names) {
  if (!root || names.size === 0) return [];
  const isKnown = (el) => {
    const text = textOf(el);
    return text.length > 0 && text.length <= MAX_NAME_LENGTH && names.has(normalizeName(text));
  };
  return [...root.querySelectorAll("*")].filter(
    (el) => isKnown(el) && ![...el.children].some(isKnown)
  );
}

/**
 * The chat list found by structure alone: the element with the most children that each show a
 * known chat name (at least two). The open chat's header also shows a name, but the list wins
 * because it holds several. Ties go to the deeper element.
 */
function listContainer(root, names) {
  const children = new Map(); // ancestor -> Set of its children leading to a known name
  for (const el of knownNameElements(root, names)) {
    let child = el;
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (!children.has(node)) children.set(node, new Set());
      children.get(node).add(child);
      if (node === root) break;
      child = node;
    }
  }
  let best = null;
  for (const [node, kids] of children) {
    if (kids.size < 2) continue;
    const bestSize = best ? children.get(best).size : 0;
    if (kids.size > bestSize || (kids.size === bestSize && depthOf(node) > depthOf(best))) {
      best = node;
    }
  }
  return best;
}

/**
 * Reads WhatsApp's chat list without depending on WhatsApp's markup names alone. Every lookup
 * tries, in order: what was LEARNED from notifications, WhatsApp's names of TODAY, page
 * STRUCTURE (using chat names we already know), and English labels LAST.
 *
 * `knownNames()` supplies chat names the extension has seen (notifications, saved chats, rules).
 * `learned` restores fingerprints from an earlier session; `onLearn(learned)` is told whenever a
 * new fingerprint becomes trusted, so it can be saved. Fingerprints never contain names or text.
 */
export function createPageModel({
  document,
  knownNames = () => [],
  learned = null,
  onLearn = () => {},
}) {
  const trusted = sanitizeLearned(learned);
  const candidates = { name: null, counter: null };

  const names = () =>
    new Set(
      (knownNames() ?? []).map((n) => normalizeName(typeof n === "string" ? n : "")).filter(Boolean)
    );
  const body = () => document.body ?? document.documentElement;

  /** The element whose changes mean the chat list changed, or null. */
  function findPane() {
    const strong = first(document, STRONG_PANES);
    if (strong) return strong;
    const structural = listContainer(body(), names());
    if (structural) return structural;
    return first(document, LABEL_PANES);
  }

  function rows(known) {
    const fromPane = (pane) => {
      const marked = pane.querySelectorAll(ROW_SELECTOR);
      if (marked.length > 0) return [...marked];
      const container = listContainer(pane, known);
      return container ? [...container.children] : [];
    };
    const strong = first(document, STRONG_PANES);
    if (strong) return fromPane(strong);
    const structural = listContainer(body(), known);
    if (structural) return [...structural.children];
    const labelled = first(document, LABEL_PANES);
    return labelled ? fromPane(labelled) : [];
  }

  function nameElementOf(row, known) {
    const learnedEl = findByFingerprint(row, trusted.name);
    if (textOf(learnedEl)) return learnedEl;
    const strong = first(row, STRONG_TITLES);
    if (textOf(strong)) return strong;
    const byKnownName = knownNameElements(row, known)[0];
    if (byKnownName) return byKnownName;
    const loose = first(row, LOOSE_TITLES);
    return textOf(loose) ? loose : null;
  }

  /**
   * The unread counter, by structure: a digits-only leaf AFTER the row's last titled element
   * (the time comes before the preview, the counter after it; previews carry a title), and not
   * inside the name. The last such number wins.
   */
  function structuralCounter(row, nameEl) {
    const titled = row.querySelectorAll("[title]");
    const lastTitled = titled[titled.length - 1] ?? null;
    let found = null;
    for (const el of row.querySelectorAll("*")) {
      if (el.children.length > 0 || !DIGITS.test(el.textContent.trim())) continue;
      if (nameEl && (nameEl === el || nameEl.contains(el))) continue;
      if (lastTitled) {
        if (lastTitled === el || lastTitled.contains(el)) continue;
        if (!(lastTitled.compareDocumentPosition(el) & FOLLOWING)) continue;
      }
      found = el;
    }
    return found;
  }

  function counterElementOf(row, nameEl) {
    const learnedEl = findByFingerprint(row, trusted.counter);
    if (learnedEl && DIGITS.test(learnedEl.textContent.trim())) return learnedEl;
    const builtIn = row.querySelector(UNREAD_SELECTOR);
    if (builtIn) return builtIn;
    const structural = structuralCounter(row, nameEl);
    if (structural) return structural;
    return (
      [...row.querySelectorAll("[aria-label]")].find((el) =>
        UNREAD_LABEL.test(el.getAttribute("aria-label"))
      ) ?? null
    );
  }

  function countOf(el) {
    if (!el) return 0;
    // Only a number counts: a "marked as unread" dot is the user's doing, not a new message.
    const text = el.textContent.trim();
    if (DIGITS.test(text)) return Number(text);
    const fromLabel = /(\d+)/.exec(el.getAttribute("aria-label") ?? "");
    return fromLabel ? Number(fromLabel[1]) : 0;
  }

  function mutedMarked(row) {
    return row.querySelector(MUTED_MARKER) !== null || row.querySelector(MUTED_LABEL) !== null;
  }

  /** Every rendered chat: Map(normalized name -> { name, count, muted }). */
  function readChats() {
    const chats = new Map();
    try {
      const known = names();
      for (const row of rows(known)) {
        if (isNotAChat(row)) continue;
        const nameEl = nameElementOf(row, known);
        const name = textOf(nameEl);
        if (!name || name.length > MAX_NAME_LENGTH) continue;
        const key = normalizeName(name);
        const count = countOf(counterElementOf(row, nameEl));
        const muted = mutedMarked(row);
        const seen = chats.get(key);
        chats.set(key, {
          name: seen?.name ?? name,
          count: Math.max(seen?.count ?? 0, count),
          muted: Boolean(seen?.muted) || muted,
        });
      }
    } catch {
      // An unexpected page: report what was read so far.
    }
    return chats;
  }

  /** Chat names in on-screen order. */
  function readNames() {
    return [...readChats().values()].map((chat) => chat.name);
  }

  function observe(kind, fp) {
    const candidate = candidates[kind];
    if (candidate && sameFingerprint(candidate.fp, fp)) candidate.hits += 1;
    else candidates[kind] = { fp, hits: 1 };
    if (candidates[kind].hits >= CONFIRMATIONS && !sameFingerprint(trusted[kind], fp)) {
      trusted[kind] = fp;
      return true;
    }
    return false;
  }

  function learnedNow() {
    return { name: trusted.name, counter: trusted.counter };
  }

  /**
   * WhatsApp just notified about chat `title`: its row is now known for certain, so remember
   * what its name and unread counter look like.
   */
  function learnFrom(title) {
    try {
      const key = normalizeName(typeof title === "string" ? title : "");
      if (!key) return;
      const known = names();
      known.add(key);
      for (const row of rows(known)) {
        if (isNotAChat(row)) continue;
        const nameEl = nameElementOf(row, known);
        if (!nameEl || normalizeName(textOf(nameEl)) !== key) continue;
        let changed = observe("name", fingerprintOf(nameEl, row));
        const counterEl = counterElementOf(row, nameEl);
        if (countOf(counterEl) > 0) {
          changed = observe("counter", fingerprintOf(counterEl, row)) || changed;
        }
        if (changed) onLearn(learnedNow());
        return;
      }
    } catch {
      // Learning is a bonus; never let it disturb anything.
    }
  }

  return { findPane, readChats, readNames, learnFrom, learned: learnedNow };
}
