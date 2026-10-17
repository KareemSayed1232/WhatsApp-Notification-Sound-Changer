// @vitest-environment node
// esbuild runs in Node and breaks under jsdom's TextEncoder/Uint8Array globals.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, targets } from "../../scripts/build.mjs";

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "wansc-build-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("build script", () => {
  it("builds the chromium target with a valid MV3 manifest", async () => {
    const out = path.join(tempDir(), "chromium");
    await build("chromium", { outDir: out });
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBeTruthy();
    expect(manifest.version).toMatch(/^\d+(\.\d+){0,3}$/);
  });

  it("copies every file the manifest references", async () => {
    const out = path.join(tempDir(), "chromium");
    await build("chromium", { outDir: out });
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    const referenced = [
      manifest.action?.default_popup,
      manifest.options_ui?.page,
      manifest.action?.default_icon,
      manifest.background?.service_worker,
      ...Object.values(manifest.icons ?? {}),
      ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? []),
      ...(manifest.web_accessible_resources ?? []).flatMap((r) => r.resources),
    ].filter(Boolean);
    expect(referenced.length).toBeGreaterThan(0);
    for (const file of referenced) {
      expect(existsSync(path.join(out, file)), `${file} missing from build`).toBe(true);
    }
  });

  it("bundles every entry into a self-contained classic script", async () => {
    const out = path.join(tempDir(), "chromium");
    await build("chromium", { outDir: out });
    for (const file of [
      "background.js",
      "content/main-hook.js",
      "content/bridge.js",
      "ui/popup.js",
      "ui/options.js",
    ]) {
      const code = readFileSync(path.join(out, file), "utf8");
      expect(code, `${file} must not contain ES module syntax`).not.toMatch(
        /^\s*(import\s|export\s)/m
      );
      expect(() => new Function(code), `${file} must parse as a classic script`).not.toThrow();
    }
  });

  it("keeps the page-world hook free of extension APIs", async () => {
    const out = path.join(tempDir(), "chromium");
    await build("chromium", { outDir: out });
    const hook = readFileSync(path.join(out, "content/main-hook.js"), "utf8");
    expect(hook).not.toMatch(/chrome\.(runtime|storage)/);
    expect(hook).not.toContain("contact");
  });

  it("injects the hook into the page world at document_start, before the bridge", async () => {
    const out = path.join(tempDir(), "chromium");
    await build("chromium", { outDir: out });
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    const [hook, bridge] = manifest.content_scripts;
    expect(hook).toMatchObject({
      js: ["content/main-hook.js"],
      world: "MAIN",
      run_at: "document_start",
    });
    expect(bridge.js).toEqual(["content/bridge.js"]);
    expect(bridge.world).toBeUndefined();
    expect(hook.matches).toEqual(["https://web.whatsapp.com/*"]);
  });

  it("requests only the permissions it needs (no tabs, no offscreen)", async () => {
    const out = path.join(tempDir(), "chromium");
    await build("chromium", { outDir: out });
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.host_permissions).toEqual(["https://web.whatsapp.com/*"]);
  });

  it("does not ship the superseded offscreen/tab-muting scripts", async () => {
    const out = path.join(tempDir(), "chromium");
    await build("chromium", { outDir: out });
    expect(existsSync(path.join(out, "audio_player"))).toBe(false);
    expect(existsSync(path.join(out, "scripts/service-worker.js"))).toBe(false);
  });

  it("rejects unknown targets", async () => {
    await expect(build("netscape")).rejects.toThrow(/Unknown target/);
  });

  it("exposes at least the chromium target", () => {
    expect(Object.keys(targets)).toContain("chromium");
  });
});
