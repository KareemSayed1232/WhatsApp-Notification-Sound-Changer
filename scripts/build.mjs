import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

// Each entry is bundled into one self-contained classic script (no import/export), because
// content scripts and Firefox event pages cannot load ES modules.
const ENTRIES = {
  "background.js": "background/background.entry.mjs",
  "content/main-hook.js": "content/main-hook.entry.mjs",
  "content/bridge.js": "content/bridge.entry.mjs",
};

// Copied as-is. (The popup is replaced by the redesigned UI in Phase 4.)
const STATIC_FILES = ["icons", "popup.html", "popup.css", "scripts/popup.js"];

/**
 * Per-browser manifest transforms. Each takes the source manifest and returns the manifest
 * for that target. Only "chromium" is shipped so far; "firefox" arrives with the Phase 5 packaging.
 */
export const targets = {
  chromium: (manifest) => manifest,
};

export async function build(target, { outDir = path.join(root, "dist", target) } = {}) {
  const transform = targets[target];
  if (!transform) {
    throw new Error(
      `Unknown target "${target}". Known targets: ${Object.keys(targets).join(", ")}`
    );
  }

  const manifest = JSON.parse(await readFile(path.join(srcDir, "manifest.json"), "utf8"));

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const [outFile, entry] of Object.entries(ENTRIES)) {
    await bundle({
      entryPoints: [path.join(srcDir, entry)],
      outfile: path.join(outDir, outFile),
      bundle: true,
      format: "iife",
      target: ["chrome111", "firefox128"],
      legalComments: "none",
      logLevel: "silent",
    });
  }

  for (const file of STATIC_FILES) {
    await cp(path.join(srcDir, file), path.join(outDir, file), { recursive: true });
  }

  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(transform(manifest), null, 2));
  return outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : Object.keys(targets);
  for (const name of names) {
    const dir = await build(name);
    console.log(`built ${name} -> ${path.relative(root, dir)}`);
  }
}
