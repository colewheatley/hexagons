import { access, cp, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const freigerSectorBounds = { minQ: 76, maxQ: 82, minR: 246, maxR: 255 };

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await cp(path.join(root, "frontend", "app"), dist, {
  recursive: true,
  filter: (src) => {
    const lowDir = `${path.sep}aerial_tiles${path.sep}low`;
    const vendorDir = `${path.sep}vendor`;
    return (
      path.basename(src) !== ".DS_Store" &&
      !src.endsWith(".bak") &&
      !src.endsWith(lowDir) &&
      !src.includes(`${lowDir}${path.sep}`) &&
      !src.endsWith(vendorDir) &&
      !src.includes(`${vendorDir}${path.sep}`)
    );
  },
});

function isFreigerSector(q, r) {
  return (
    q >= freigerSectorBounds.minQ &&
    q <= freigerSectorBounds.maxQ &&
    r >= freigerSectorBounds.minR &&
    r <= freigerSectorBounds.maxR
  );
}

async function pruneSectorDirectory(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^sector_(-?\d+)_(-?\d+)\.(?:bin|webp)$/);
    if (!match) continue;
    const q = Number(match[1]);
    const r = Number(match[2]);
    if (!isFreigerSector(q, r)) {
      await unlink(path.join(dir, entry.name));
    }
  }
}

async function writeFreigerManifest() {
  const manifestPath = path.join(dist, "tile_manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.tiles = manifest.tiles.filter((tile) => isFreigerSector(tile.q, tile.r));
  manifest.bounds = manifest.tiles.reduce(
    (bounds, tile) => ({
      min_x: Math.min(bounds.min_x, tile.x),
      max_x: Math.max(bounds.max_x, tile.x + manifest.sector_size_m),
      min_y: Math.min(bounds.min_y, tile.y),
      max_y: Math.max(bounds.max_y, tile.y + manifest.sector_size_m),
    }),
    { min_x: Infinity, max_x: -Infinity, min_y: Infinity, max_y: -Infinity }
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

await pruneSectorDirectory(path.join(dist, "tiles_bin"));
await pruneSectorDirectory(path.join(dist, "aerial_tiles", "full"));
await writeFreigerManifest();

await mkdir(path.join(dist, "vendor", "three", "build"), { recursive: true });
await mkdir(path.join(dist, "vendor", "three", "examples", "jsm", "controls"), { recursive: true });
await cp(
  path.join(root, "node_modules", "three", "build", "three.module.js"),
  path.join(dist, "vendor", "three", "build", "three.module.js")
);
for (const file of ["MapControls.js", "OrbitControls.js"]) {
  await cp(
    path.join(root, "node_modules", "three", "examples", "jsm", "controls", file),
    path.join(dist, "vendor", "three", "examples", "jsm", "controls", file)
  );
}

if (process.env.FREIGER_INCLUDE_APK === "1") {
  const debugApk = path.join(root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  try {
    await access(debugApk);
    await mkdir(path.join(dist, "apk"), { recursive: true });
    await cp(debugApk, path.join(dist, "apk", "hexagons-freiger-debug.apk"));
  } catch {
    // The APK appears only after the Android build; web deploy builds should still work before that.
  }
}
