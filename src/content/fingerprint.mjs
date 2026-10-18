// What an element in a chat row LOOKS like (its tag, WhatsApp's test id, which attributes it
// has, how deep it sits in the row), so the same element can be found again in other rows after
// WhatsApp renames things. A fingerprint never holds text, titles or labels: those carry chat
// names and message previews.

// Attributes whose VALUES or presence vary per chat or per render, so they are left out.
const IGNORED = new Set([
  "class",
  "style",
  "title",
  "aria-label",
  "dir",
  "id",
  "tabindex",
  "data-testid", // recorded separately, as its value
  "src",
  "href",
  "alt",
]);
const MAX_DEPTH = 30;
const TAG = /^[A-Z][A-Z0-9-]{0,30}$/;
const ATTR = /^[a-z][a-z0-9_.:-]{0,60}$/;
const TESTID = /^[\w.:-]{1,80}$/;

function depthOf(el, row) {
  let depth = 0;
  for (let node = el; node && node !== row; node = node.parentElement) depth += 1;
  return depth;
}

function attrNamesOf(el) {
  return [...el.attributes]
    .map((a) => a.name.toLowerCase())
    .filter((name) => !IGNORED.has(name) && !name.startsWith("aria-"))
    .sort();
}

export function fingerprintOf(el, row) {
  return {
    tag: el.tagName.toUpperCase(),
    testid: el.getAttribute("data-testid") || null,
    attrs: attrNamesOf(el),
    depth: depthOf(el, row),
  };
}

export function sameFingerprint(a, b) {
  return Boolean(
    a &&
    b &&
    a.tag === b.tag &&
    a.testid === b.testid &&
    a.depth === b.depth &&
    a.attrs.length === b.attrs.length &&
    a.attrs.every((name, i) => name === b.attrs[i])
  );
}

/** The first element in `row` with this fingerprint, or null. */
export function findByFingerprint(row, fp) {
  if (!row || !fp) return null;
  for (const el of row.getElementsByTagName(fp.tag)) {
    if (sameFingerprint(fingerprintOf(el, row), fp)) return el;
  }
  return null;
}

/** A stored fingerprint, checked; null when it is not one. */
export function sanitizeFingerprint(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { tag, testid, attrs, depth } = raw;
  if (typeof tag !== "string" || !TAG.test(tag)) return null;
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) return null;
  if (!Array.isArray(attrs) || !attrs.every((a) => typeof a === "string" && ATTR.test(a))) {
    return null;
  }
  if (testid !== null && (typeof testid !== "string" || !TESTID.test(testid))) return null;
  return { tag, testid, attrs: [...attrs].sort(), depth };
}
