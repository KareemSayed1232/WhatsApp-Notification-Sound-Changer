// "Copy page layout" (Settings → Troubleshooting): a copy of WhatsApp's chat list for a bug report
// after WhatsApp changes it. Only the structure is kept. Every name, message and id is replaced,
// the same text by the same placeholder so the structure still lines up, and only numbers, times,
// "N unread messages" and WhatsApp's own interface words stay readable.

const MAX_ROWS = 20;
const ROWS = '[role="row"], [role="listitem"]';
const ANCESTORS = 3;

const KEEP_TEXT = [
  /^\d{1,4}$/, // unread counters
  /^\d{1,2}[:.]\d{2}(\s?[ap]\.?m\.?)?$/i, // times
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/, // dates
  /^\d{1,4} unread messages?$/i,
  /^(true|false)$/,
];
const UI_WORDS = new Set([
  "archived",
  "locked chats",
  "chats",
  "chat list",
  "muted chat",
  "pinned chat",
  "photo",
  "video",
  "voice message",
  "audio",
  "sticker",
  "gif",
  "document",
  "contact",
  "location",
  "yesterday",
  "today",
  "online",
  "typing…",
  "typing...",
]);
// Attributes that describe structure. Everything else (links, image addresses, data-id with
// phone numbers, inline handlers) is dropped.
const KEEP_ATTRIBUTES = new Set([
  "role",
  "dir",
  "tabindex",
  "type",
  "id",
  "class",
  "data-testid",
  "data-icon",
  "title",
]);
const TEXT_ATTRIBUTES = new Set([
  "title",
  "aria-label",
  "aria-description",
  "aria-roledescription",
]);
const DROP_ELEMENTS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const LOOKS_PERSONAL = /@|\d{6,}/;

function anonymizer() {
  const placeholders = new Map();
  return (raw) => {
    const value = raw.trim();
    if (value === "" || KEEP_TEXT.some((re) => re.test(value))) return raw;
    if (UI_WORDS.has(value.toLowerCase())) return raw;
    if (!placeholders.has(value)) placeholders.set(value, `Text ${placeholders.size + 1}`);
    return placeholders.get(value);
  };
}

function cleanElement(element, hide) {
  for (const { name, value } of [...element.attributes]) {
    const keep = KEEP_ATTRIBUTES.has(name) || name.startsWith("aria-");
    if (!keep) element.removeAttribute(name);
    else if (TEXT_ATTRIBUTES.has(name)) element.setAttribute(name, hide(value));
    else if (LOOKS_PERSONAL.test(value)) element.setAttribute(name, "x");
    else if (name.startsWith("aria-") && !KEEP_TEXT.some((re) => re.test(value))) {
      element.setAttribute(name, hide(value));
    }
  }
  // Icons: the element and its attributes are enough; their drawing is not needed.
  if (element.localName === "svg") element.replaceChildren();
}

function clean(root, hide) {
  const walker = root.ownerDocument.createTreeWalker(root, 1 | 4 | 128); // elements, text, comments
  const remove = [];
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    if (node.nodeType === 8) remove.push(node);
    else if (node.nodeType === 3) node.nodeValue = hide(node.nodeValue);
    else if (DROP_ELEMENTS.has(node.nodeName)) remove.push(node);
    else if (node.nodeType === 1) cleanElement(node, hide);
  }
  for (const node of remove) node.remove();
}

/** Only the first rows: enough to see the structure, and a short report. */
function trimRows(root) {
  const rows = [...root.querySelectorAll(ROWS)].filter((row) => !row.parentElement?.closest(ROWS));
  for (const row of rows.slice(MAX_ROWS)) row.remove();
}

/**
 * The chat list's markup with names, messages and ids replaced, inside empty copies of its
 * nearest parents (some are how the list is found). Null when there is no chat list.
 */
export function captureLayout({ document, findPane }) {
  const pane = findPane();
  if (!pane) return null;
  const hide = anonymizer();

  let copy = pane.cloneNode(true);
  trimRows(copy);
  let parent = pane.parentElement;
  for (let i = 0; i < ANCESTORS && parent && parent !== document.body; i++) {
    const shell = parent.cloneNode(false);
    shell.append(copy);
    copy = shell;
    parent = parent.parentElement;
  }
  const holder = document.createElement("div");
  holder.append(copy);
  clean(copy, hide);
  return holder.innerHTML;
}
