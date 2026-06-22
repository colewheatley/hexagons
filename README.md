# Hexagons — 3D Hexagonal Terrain Viewer

A browser-based 3D terrain viewer that renders the Austrian Tirol using a hexagonal grid system. The backend "bakes" elevation and aerial imagery into compact per-sector binary files, and the frontend streams them into a Three.js scene with LOD management.

## Project Structure

```
├── hex_backend/            # Python baking pipeline
│   ├── waffle_iron.py      # Main baker — see header for full data specs
│   ├── coordinate_utility.py  # EPSG:31254 ↔ hex/sector coordinate math
│   ├── generate_manifest.py   # Builds tile_manifest.json from baked output
│   ├── run_lil_bake.sh     # Quick mini-bake script (default: 12×12 Stubai)
│   ├── run_big_bake.sh     # Full Tirol bake (hours, needs ~50GB)
│   └── aerial_tifs/        # Source orthophotos (git-ignored, ~25 GB)
│
├── frontend/
│   ├── app/                # The viewer (vanilla JS + Three.js)
│   │   ├── index.html      # Entry point
│   │   ├── main.js         # PistonViewer — scene, camera, tile loading
│   │   ├── tile_worker.js  # Web Worker for hex mesh generation
│   │   ├── lod_controller.js  # LOD distance & budget management
│   │   ├── coordinate_utility.js
│   │   ├── style.css
│   │   ├── tiles_bin/      # Baked .bin sectors (git-ignored)
│   │   ├── aerial_tiles/   # Baked full-resolution .webp textures (git-ignored)
│   │   └── assets/         # Static data (skigebiete.json, peaks geojson)
│   └── landing/            # Marketing landing page
│
└── hive_assets/            # Dev tooling & test harnesses
    ├── init_worktree.sh    # Creates sandboxed git worktrees with symlinks
    └── gemini_test.sh      # Automated test runner
```

## Large Files (Not in Git)

These files are required for baking but are too large for the repository:

| File | Size | Description |
|---|---|---|
| `hex_backend/DGM_Tirol_5m_epsg31254_2006_2020.tif` | 1.1 GB | 5m DEM of Tirol (EPSG:31254) |
| `hex_backend/DGM_Tirol_gradient_cached.tif` | 14 GB | Full-region gradient cache (only needed for `--full` bakes) |
| `hex_backend/aerial_tifs/*.tif` | 24.6 GB | 3,486 RGB orthophotos (~7 MB avg) |

The mini-bake generates its own **regional gradient** on-the-fly (~25–158 MB) so it does **not** need the 14 GB gradient cache.

## Baking

The baker (`waffle_iron.py`) converts raw DEM + aerial TIFs into the binary format the viewer consumes.

```bash
# Default: 12×12 grid around Stubai Glacier
./hex_backend/run_lil_bake.sh

# Configurable grid size (1–16)
python3 hex_backend/waffle_iron.py --grid 4

# Custom center sector
python3 hex_backend/waffle_iron.py --grid 6 --center 73,252

# Force re-bake (ignore version skip)
python3 hex_backend/waffle_iron.py --force

# Full Tirol bake (needs all aerial TIFs + DEM)
python3 hex_backend/waffle_iron.py --full
```

**Performance** (MacBook M1, 16 GB shared RAM): ~4.7s/sector. A 12×12 bake (144 sectors) takes ~11 minutes.

## Running the Viewer

```bash
# From the project root
npx http-server frontend/app -p 8099
# OR (if node is not available or for a quick test)
python3 -m http.server 8099 --directory frontend/app
```

Then open `http://localhost:8099/`.

## Coordinate System

- **Projection**: EPSG:31254 (MGI / Austria GK West)
- **Hex orientation**: Flat-top
- **Unit hex width**: 6.4 meters
- **Sector size**: 128×128 hexes = 819.2 meters
- **Hex coordinate encoding**: Axial (q, r)

## Freiger Branch — Three-Variant Offline Build

> **This section only applies to the `freiger` branch.** It is a one-shot, offline build for the Wilder Freiger ski tour (28 fixed sectors). The main `master` branch streams tiles from S3 and has no APK pipeline.

Three artefacts are produced from the same source app, selected at build time via `--variant`:

| Variant | Textures | VRAM (28 tiles) | Target |
|---|---|---|---|
| `web` | webp q=10 @ 2048² | ~450 MB | Desktop / iPhone (streamed from wheatley.cloud) |
| `apk-low` | webp q=85 @ 2048² | ~175 MB | Older Android phones |
| `apk-high` | webp lossless @ 4992² | ~2.8 GB | High-RAM Android (12 GB+) |

### Build Requirements
```bash
brew install openjdk@21 android-commandlinetools   # first time only
yes | sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"
```

### Workflow

```bash
# 1. Bake hi-res lossless tiles from freiger/orthos/source (once, ~8 min)
./hex_backend/run_freiger_bake.sh

# 2. Build APKs
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export JAVA_HOME=$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

npm run apk:high   # → android/app/build/outputs/apk/debug/app-debug.apk (~1.6 GB)
npm run apk:low    # → android/app/build/outputs/apk/debug/app-debug.apk (~47 MB)
npm run build:web  # → dist/ for S3 deployment
```

Rename each APK after building (gradle always outputs to the same path).

## Sandbox Worktrees

For isolated development (e.g., frontend changes without affecting baked data), use the worktree script:

```bash
./hive_assets/init_worktree.sh <worktree-path> <branch-name>
```

This creates a git worktree with symlinks to large files (DEM, TIFs, baked tiles) so multiple agents can work in parallel without duplicating ~40 GB of data.
