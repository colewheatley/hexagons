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
│   │   ├── search.js       # Search overlay (peaks + ski areas)
│   │   ├── coordinate_utility.js
│   │   ├── style.css
│   │   ├── tiles_bin/      # Baked .bin sectors (git-ignored)
│   │   ├── aerial_tiles/   # Baked .webp textures (git-ignored)
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
```

Then open `http://localhost:8099/`.

## Coordinate System

- **Projection**: EPSG:31254 (MGI / Austria GK West)
- **Hex orientation**: Flat-top
- **Unit hex width**: 6.4 meters
- **Sector size**: 128×128 hexes = 819.2 meters
- **Hex coordinate encoding**: Axial (q, r)

## Sandbox Worktrees

For isolated development (e.g., frontend changes without affecting baked data), use the worktree script:

```bash
./hive_assets/init_worktree.sh <worktree-path> <branch-name>
```

This creates a git worktree with symlinks to large files (DEM, TIFs, baked tiles) so multiple agents can work in parallel without duplicating ~40 GB of data.
