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

  it("rejects unknown targets", async () => {
    await expect(build("netscape")).rejects.toThrow(/Unknown target/);
  });

  it("exposes at least the chromium target", () => {
    expect(Object.keys(targets)).toContain("chromium");
  });
});
