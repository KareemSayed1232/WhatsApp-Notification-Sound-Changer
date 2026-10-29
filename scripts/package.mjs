import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webExt from "web-ext";
import { build, targets } from "./build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Build every browser target and zip each one for its store:
 *   chromium -> Chrome Web Store, Edge Add-ons, Opera add-ons (and sideloading in Brave/Vivaldi)
 *   firefox  -> addons.mozilla.org
 * Output: dist/packages/<name>-<version>-<target>.zip
 */
export async function packageAll({ names = Object.keys(targets), artifactsDir } = {}) {
  const out = artifactsDir ?? path.join(root, "dist", "packages");
  await mkdir(out, { recursive: true });
  const results = {};

  for (const target of names) {
    const sourceDir = await build(target);
    const manifest = JSON.parse(await readFile(path.join(sourceDir, "manifest.json"), "utf8"));
    const slug = manifest.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const result = await webExt.cmd.build(
      {
        sourceDir,
        artifactsDir: out,
        filename: `${slug}-${manifest.version}-${target}.zip`,
        overwriteDest: true,
      },
      { shouldExitProgram: false }
    );
    results[target] = result.extensionPath;
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2);
  const results = await packageAll(requested.length > 0 ? { names: requested } : {});
  for (const [target, file] of Object.entries(results)) {
    console.log(`${target}: ${path.relative(root, file)}`);
  }
}
