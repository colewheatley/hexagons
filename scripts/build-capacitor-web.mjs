import { access, cp, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");

// Accept --variant=web|apk-low|apk-high (default: web)
const variantArg = process.argv.find((a) => a.startsWith("--variant="));
const VARIANT = variantArg ? variantArg.split("=")[1] : "web";
const VALID_VARIANTS = ["web", "apk-low", "apk-high"];
if (!VALID_VARIANTS.includes(VARIANT)) {
  console.error(`Unknown variant "${VARIANT}". Use one of: ${VALID_VARIANTS.join(", ")}`);
  process.exit(1);
}
console.log(`Building variant: ${VARIANT}`);

// Only bundle the sectors that actually appear in tile_manifest.json
const freigerSectorBounds = { minQ: 77, maxQ: 80, minR: 248, maxR: 254 };

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

// Repackage aerials for variant (resizes web/apk-low to 2048², lossless pass-through for apk-high)
if (VARIANT !== "apk-high") {
  execFileSync(
    "python3",
    [
      path.join(root, "scripts", "repackage-aerials.py"),
      "--variant", VARIANT,
      "--dir", path.join(dist, "aerial_tiles", "full"),
    ],
    { stdio: "inherit" }
  );
}

// Inject variant meta tag into dist/index.html
const indexPath = path.join(dist, "index.html");
let indexHtml = await readFile(indexPath, "utf8");
indexHtml = indexHtml.replace(
  "<!-- {{HEXAGONS_VARIANT}} -->",
  `<meta name="hexagons-variant" content="${VARIANT}">`
);
await writeFile(indexPath, indexHtml);

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

// Only bundle the APK into the web deployment (for the S3 download page).
// Never include it during APK builds — it creates a self-referential loop.
if (VARIANT === "web") {
  const debugApk = path.join(root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  try {
    await access(debugApk);
    await mkdir(path.join(dist, "apk"), { recursive: true });
    await cp(debugApk, path.join(dist, "apk", "hexagons-freiger-debug.apk"));
    console.log("Bundled APK into web dist for download page.");
  } catch {
    // APK not yet built; web deploy without it is still valid.
  }
}

console.log(`Build complete → dist/ (variant: ${VARIANT})`);
