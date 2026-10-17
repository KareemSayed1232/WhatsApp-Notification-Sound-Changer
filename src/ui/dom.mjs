// Properties that must be set as DOM properties (not attributes) to behave correctly.
const PROPERTIES = new Set(["id", "title", "disabled", "hidden", "selected", "checked"]);

/**
 * Tiny element builder. Children that are strings become text nodes, never HTML, so contact
 * names and file names coming from outside can never inject markup.
 */
export function h(doc, tag, props = {}, ...children) {
  const el = doc.createElement(tag);
  let value;
  let hasValue = false;

  for (const [key, val] of Object.entries(props)) {
    if (val === undefined || val === null || val === false) continue;
    if (key === "class") el.className = val;
    else if (key === "for") el.htmlFor = val;
    else if (key === "dataset") Object.assign(el.dataset, val);
    else if (key === "value") {
      value = val;
      hasValue = true;
    } else if (key.startsWith("on") && typeof val === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (PROPERTIES.has(key)) el[key] = val;
    else el.setAttribute(key, val === true ? "" : String(val));
  }

  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child.nodeType ? child : doc.createTextNode(String(child)));
  }

  // A select's value only sticks once its options exist.
  if (hasValue) el.value = value;
  return el;
}

/** Replace the options of a <select>, keeping `selected` when it is still available. */
export function fillSelect(doc, select, options, selected) {
  select.replaceChildren(...options.map((o) => h(doc, "option", { value: o.value }, o.label)));
  const wanted = options.some((o) => o.value === selected) ? selected : options[0]?.value;
  if (wanted !== undefined) select.value = wanted;
}
