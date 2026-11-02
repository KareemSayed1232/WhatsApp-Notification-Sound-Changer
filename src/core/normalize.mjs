// Characters that WhatsApp (or a contact list) may insert and that must not make two visually
// identical names differ. Built from code points, not literals, so no invisible characters
// live in this source file.
const INVISIBLE_RANGES = [
  [0x200b, 0x200f], // zero-width space/joiners, LRM, RLM
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // byte order mark / zero-width no-break space
  [0xfe0e, 0xfe0f], // text/emoji variation selectors
];

const INVISIBLE = new RegExp(
  INVISIBLE_RANGES.map(([from, to]) => `${hex(from)}-${hex(to)}`)
    .map((range) => `[${range}]`)
    .join("|"),
  "g"
);

function hex(codePoint) {
  return `\\u${codePoint.toString(16).padStart(4, "0")}`;
}

/** A name cleaned for display: invisible marks removed, whitespace collapsed, case kept. */
export function cleanDisplayName(value) {
  if (typeof value !== "string") return "";
  return value.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

// Text in a chat row that is never a chat's name: the unread count, its label, a time, a date.
const NOT_A_NAME = [
  /^\d{1,4}$/,
  /^\d+\s+unread\s+messages?$/i,
  /^\d{1,2}[:.]\d{2}(\s?[ap]\.?m\.?)?$/i,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
];
const MAX_NAME_LENGTH = 100;

/** Is this an unread count, its label, a time or a date (text that is never a name)? */
export function isCountOrTime(value) {
  const text = cleanDisplayName(value);
  return text !== "" && NOT_A_NAME.some((re) => re.test(text));
}

/** Could this be a chat's name? Not empty, not too long, not a count, a time or a date. */
export function looksLikeChatName(value) {
  const name = cleanDisplayName(value);
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && !isCountOrTime(name);
}

/** Canonical form used to compare contact/chat names. Never use it for display. */
export function normalizeName(value) {
  if (typeof value !== "string") return "";
  return cleanDisplayName(value.normalize("NFKC")).toLowerCase();
}
