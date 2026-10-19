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
  "ui/popup.js": "ui/popup.entry.mjs",
  "ui/options.js": "ui/options.entry.mjs",
  "ui/upload.js": "ui/upload.entry.mjs",
};

// Copied as-is.
const STATIC_FILES = [
  "icons",
  "ui/popup.html",
  "ui/options.html",
  "ui/upload.html",
  "ui/upload.css",
  "ui/ui.css",
  "ui/popup.css",
  "ui/options.css",
];

/**
 * Per-browser manifest transforms. Each takes the source manifest and returns the manifest
 * for that target. Only "chromium" is shipped so far; "firefox" arrives with the Phase 5 packaging.
 */
// Used only to give Firefox a stable add-on id; change it if you publish under your own domain.
export const GECKO_ID = "whatsapp-sound-changer@kareemsayed1232.github.io";

const omit = (object, ...keys) =>
  Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

export const targets = {
  // Chrome, Edge, Brave, Opera, Vivaldi and other Chromium browsers.
  chromium: (manifest) => omit(manifest, "browser_specific_settings"),

  // Firefox 140+: MAIN-world content scripts need 128, and Mozilla now requires the
  // data_collection_permissions key, which needs 140 (Android: 142; the Android entry stays so the
  // key validates, but desktop-only is chosen when uploading to addons.mozilla.org, since WhatsApp
  // Web does not run in phone browsers). Firefox has no service
  // workers for extensions, so the same bundled file runs as a (non-persistent) event page.
  // `author` is dropped because Firefox wants a string where Chrome takes an {email} object.
  firefox: (manifest) => ({
    ...omit(manifest, "minimum_chrome_version", "author"),
    background: { scripts: [manifest.background.service_worker] },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: "140.0",
        // The extension collects and transmits nothing.
        data_collection_permissions: { required: ["none"] },
      },
      gecko_android: { strict_min_version: "142.0" },
    },
  }),

  // Safari 16.4+ (macOS/iOS). The folder must be wrapped with Apple's converter on a Mac:
  //   xcrun safari-web-extension-converter dist/safari
  safari: (manifest) => ({
    ...omit(manifest, "minimum_chrome_version"),
    browser_specific_settings: { safari: { strict_min_version: "16.4" } },
  }),
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
