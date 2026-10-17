import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

export function readSource(relPath) {
  return readFileSync(path.join(srcRoot, relPath), "utf8");
}

/**
 * Run a classic (non-module) extension script with the given globals injected
 * as function parameters, so each test gets isolated fakes for chrome, document, etc.
 */
export function loadScript(relPath, globals = {}) {
  const names = Object.keys(globals);
  const fn = new Function(...names, readSource(relPath));
  return fn(...names.map((name) => globals[name]));
}

/** A fresh, empty document so event listeners from one test never leak into another. */
export function freshDocument(html = "<!DOCTYPE html><html><head></head><body></body></html>") {
  // DOMParser comes from the jsdom test environment (see vitest.config.js), not from Node.
  return new globalThis.DOMParser().parseFromString(html, "text/html");
}
