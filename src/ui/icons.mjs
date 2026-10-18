import { h } from "./dom.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";

// Inline SVG, so the UI needs no icon font or network access. Each icon is a list of
// [element, attributes] and is built with DOM calls, never with innerHTML.
const FILLED = { fill: "currentColor", stroke: "none" };
const SHAPES = {
  play: [["path", { d: "M8 5v14l11-7z", ...FILLED }]],
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 2, ...FILLED }]],
  trash: [["path", { d: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" }]],
  upload: [["path", { d: "M12 16V4M7 9l5-5 5 5M5 20h14" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  check: [["path", { d: "M5 12l5 5 9-10" }]],
  star: [["path", { d: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" }]],
  refresh: [["path", { d: "M20 11a8 8 0 10-2.3 5.7M20 4v7h-7" }]],
  bell: [["path", { d: "M6 16V11a6 6 0 0112 0v5l2 2H4zM10 21h4" }]],
  speaker: [["path", { d: "M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" }]],
  link: [
    [
      "path",
      {
        d: "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1",
      },
    ],
  ],
  settings: [
    ["circle", { cx: 12, cy: 12, r: 3 }],
    [
      "path",
      {
        d: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1",
      },
    ],
  ],
};

function svgElement(doc, tag, attributes) {
  const element = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

export function icon(doc, name, size = 18) {
  const span = h(doc, "span", { class: "icon", "aria-hidden": "true" });
  const svg = svgElement(doc, "svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  for (const [tag, attributes] of SHAPES[name] ?? []) svg.append(svgElement(doc, tag, attributes));
  span.append(svg);
  return span;
}
