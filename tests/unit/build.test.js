// @vitest-environment node
// esbuild runs in Node and breaks under jsdom's TextEncoder/Uint8Array globals.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GECKO_ID, build, targets } from "../../scripts/build.mjs";
import { packageAll } from "../../scripts/package.mjs";

const BUNDLES = [
  "background.js",
  "content/main-hook.js",
  "content/bridge.js",
  "ui/popup.js",
  "ui/options.js",
  "ui/upload.js",
];
const TARGETS = ["chromium", "firefox"];

const built = new Map();
/** Build a target once per test file and reuse it (the OS cleans the temp dir). */
async function buildOnce(target) {
  if (!built.has(target)) {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "wansc-build-")), target);
    await build(target, { outDir: out });
    built.set(target, out);
  }
  return built.get(target);
}
const manifestOf = async (target) =>
  JSON.parse(readFileSync(path.join(await buildOnce(target), "manifest.json"), "utf8"));

describe.each(TARGETS)("%s build", (target) => {
  it("has a valid MV3 manifest", async () => {
    const manifest = await manifestOf(target);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBeTruthy();
    expect(manifest.version).toMatch(/^\d+(\.\d+){0,3}$/);
  });

  it("includes every file the manifest references", async () => {
    const out = await buildOnce(target);
    const manifest = await manifestOf(target);
    const referenced = [
      manifest.action?.default_popup,
      manifest.options_ui?.page,
      manifest.action?.default_icon,
      manifest.background?.service_worker,
      ...(manifest.background?.scripts ?? []),
      ...Object.values(manifest.icons ?? {}),
      ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? []),
    ].filter(Boolean);
    expect(referenced.length).toBeGreaterThan(0);
    for (const file of referenced) {
      expect(existsSync(path.join(out, file)), `${file} missing from ${target} build`).toBe(true);
    }
  });

  it("bundles every entry into a self-contained classic script", async () => {
    const out = await buildOnce(target);
    for (const file of BUNDLES) {
      const code = readFileSync(path.join(out, file), "utf8");
      expect(code, `${file} must not contain ES module syntax`).not.toMatch(
        /^\s*(import\s|export\s)/m
      );
      expect(() => new Function(code), `${file} must parse as a classic script`).not.toThrow();
    }
  });

  it("injects the hook into the page world at document_start, before the bridge", async () => {
    const [hook, bridge] = (await manifestOf(target)).content_scripts;
    expect(hook).toMatchObject({
      js: ["content/main-hook.js"],
      world: "MAIN",
      run_at: "document_start",
    });
    expect(hook.matches).toEqual(["https://web.whatsapp.com/*"]);
    expect(bridge.js).toEqual(["content/bridge.js"]);
    expect(bridge.world).toBeUndefined();
  });

  it("requests only the permissions it needs (no tabs, no offscreen)", async () => {
    const manifest = await manifestOf(target);
    // "scripting" only re-injects our own scripts into already-open WhatsApp tabs after an update.
    expect(manifest.permissions).toEqual(["storage", "scripting"]);
    expect(manifest.host_permissions).toEqual(["https://web.whatsapp.com/*"]);
  });

  it("ships no remote code and nothing the stores reject", async () => {
    const out = await buildOnce(target);
    for (const file of BUNDLES) {
      const code = readFileSync(path.join(out, file), "utf8");
      expect(code, `${file} must not use innerHTML`).not.toMatch(/\.innerHTML\s*=/);
      expect(code, `${file} must not call eval`).not.toMatch(/\beval\s*\(/);
    }
    for (const page of ["ui/popup.html", "ui/options.html", "ui/upload.html"]) {
      const html = readFileSync(path.join(out, page), "utf8");
      expect(html, `${page} must not load remote resources`).not.toMatch(/(src|href)="https?:/);
    }
  });

  it("does not ship the superseded offscreen/tab-muting scripts", async () => {
    const out = await buildOnce(target);
    expect(existsSync(path.join(out, "audio_player"))).toBe(false);
    expect(existsSync(path.join(out, "scripts/service-worker.js"))).toBe(false);
  });
});

describe("the same code runs on every browser", () => {
  it("ships byte-identical bundles to every target (no per-browser forks of the logic)", async () => {
    const reference = await buildOnce("chromium");
    for (const target of TARGETS.slice(1)) {
      const out = await buildOnce(target);
      for (const file of BUNDLES) {
        const same =
          readFileSync(path.join(out, file), "utf8") ===
          readFileSync(path.join(reference, file), "utf8");
        expect(same, `${file} differs between chromium and ${target}`).toBe(true);
      }
    }
  });

  it("only differs by manifest in what each browser needs to load it", async () => {
    const chromium = await manifestOf("chromium");
    for (const target of ["firefox"]) {
      const other = await manifestOf(target);
      expect(other.content_scripts).toEqual(chromium.content_scripts);
      expect(other.permissions).toEqual(chromium.permissions);
      expect(other.host_permissions).toEqual(chromium.host_permissions);
      expect(other.options_ui).toEqual(chromium.options_ui);
    }
  });

  it("exposes both targets", () => {
    expect(Object.keys(targets).sort()).toEqual([...TARGETS].sort());
  });

  it("rejects unknown targets", async () => {
    await expect(build("netscape")).rejects.toThrow(/Unknown target/);
  });
});

describe("browser-specific manifests", () => {
  it("chromium (Chrome, Edge, Brave, Opera, Vivaldi): service worker, no Firefox keys", async () => {
    const manifest = await manifestOf("chromium");
    expect(manifest.background).toEqual({ service_worker: "background.js" });
    expect(manifest.minimum_chrome_version).toBe("111");
    expect(manifest.browser_specific_settings).toBeUndefined();
  });

  it("firefox: event page instead of a service worker, add-on id, 140+, no data collection", async () => {
    const manifest = await manifestOf("firefox");
    expect(manifest.background).toEqual({ scripts: ["background.js"] });
    expect(manifest.minimum_chrome_version).toBeUndefined();
    expect(manifest.author).toBeUndefined(); // Firefox wants a string; the Chrome form is invalid
    expect(manifest.browser_specific_settings.gecko).toEqual({
      id: GECKO_ID,
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] },
    });
    // Kept so the data-collection key validates for Android too (without it, web-ext lint warns).
    // Desktop-only is chosen on addons.mozilla.org at upload; the popup no longer needs a windows
    // API anyway (it falls back to a tab, then the inline picker).
    expect(manifest.browser_specific_settings.gecko_android).toEqual({
      strict_min_version: "142.0",
    });
    expect(GECKO_ID).toMatch(/^[^@\s]+@[^@\s]+$/);
  });

  it("builds for Windows and Android only: Chromium browsers and Firefox (macOS dropped)", () => {
    expect(Object.keys(targets)).toEqual(["chromium", "firefox"]);
  });
});

describe("packaging", () => {
  it("zips every target for its store, named by browser and version", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wansc-pkg-"));
    const results = await packageAll({ artifactsDir: dir });
    for (const target of TARGETS) {
      const file = results[target];
      expect(path.basename(file)).toMatch(
        new RegExp(`^sound-changer-for-whatsapp-\\d+(\\.\\d+)*-${target}\\.zip$`)
      );
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(5_000);
    }
  }, 60_000);
});
