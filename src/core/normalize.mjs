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

/** Canonical form used to compare contact/chat names. Never use it for display. */
export function normalizeName(value) {
  if (typeof value !== "string") return "";
  return cleanDisplayName(value.normalize("NFKC")).toLowerCase();
}
