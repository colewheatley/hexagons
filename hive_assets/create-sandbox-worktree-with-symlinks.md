---
description: This document describes the workflow for creating a partially sandboxed git worktree with symlinks to large files. It also provides full project context for AI agents working on the Hexagons project.
---

# Hexagons Sandbox Workflow

> [!NOTE]
> This workflow is assigned to an agent running within a Google Antigravity playground. To ensure isolation, you must create your worktree **inside your current playground**. Do not use global directories like `/Users/cole/dev/hive/`.

## Quick Start

1. **Discover your location**:
   ```bash
   pwd
   ```

2. **Prepare the local initializer**:
   Copy the script and update the `SANDBOX_ROOT` to your current directory:
   ```bash
   cp /Users/cole/dev/Hexagons/hive_assets/init_worktree.sh ./
   sed -i '' "s|^SANDBOX_ROOT=.*|SANDBOX_ROOT=\"$(pwd)\"|" init_worktree.sh
   ```

3. **Initialize the worktree**:
   ```bash
   ./init_worktree.sh my_sandbox_name
   ```

This creates a git worktree at `./my_sandbox_name/` with all code and symlinked assets. After initialization, `cd` into the sandbox and begin working.

---

## 🏠 Where You Live

**Your project root is `$(pwd)/<your_sandbox_name>/`.** This is an isolated git worktree — a full copy of the codebase on its own branch. It lives *inside* your playground on purpose: when you grep, search, or list files, you only see your own sandbox. You cannot accidentally interfere with the main repo or with other sandboxes.

Heavy assets (DEM TIFs, baked tiles, aerial imagery, node_modules) are **symlinked** into your sandbox from the main repo. They appear as normal files/directories but are read-only shared resources. Do not delete or modify them.

Your sandbox also contains a `hive_assets/` folder with testing scripts (`performance_profiler.js`, `gemini_test.sh`, etc.). These are your tools for running automated visual regression tests and getting feedback on your changes.

When your work is done, the owner will review your branch and either merge it or discard it. You do not need to worry about cleanup.

---

## ⚠️ CRITICAL SAFETY RULES

1. **NEVER modify files in `/Users/cole/dev/Hexagons/` directly.** You are working in a sandbox worktree. All edits must happen inside your sandbox at `./<your_sandbox>/`.
2. **NEVER run `git push`, `git merge`, or `git checkout` on the main repository.** Your worktree has its own branch (`sandbox/<name>`). Do not touch `master`.
3. **NEVER delete or modify `.tif` files.** These are massive DEM datasets (1-14GB each) symlinked from the main repo. They are read-only assets.
4. **Do not run `npm install` or modify `package.json`** unless explicitly told to. `node_modules` is symlinked from the main repo.

---

## Project Overview: Hexagons (PowFinder 3D)

**Live site**: [https://wheatley.cloud/powfinder/hexagons/app/](https://wheatley.cloud/powfinder/hexagons/app/)
**Landing page**: [https://wheatley.cloud/powfinder/hexagons/landing/](https://wheatley.cloud/powfinder/hexagons/landing/)

### What Is This?

A 3D hexagonal terrain viewer for the Austrian Alps (Tirol). It renders real high-resolution DEM data as a hex grid using Three.js with WebGL instanced rendering as a technology demo for the superiority of using hexagonal "pistons" to display gradient data on their skirts instead of meshed triangles and overlayed gradients as would be typical. It's targeted at skiers. The project evolved from Powfinder as a new way to display the data but now qualifies as its own project. 

### Development Stage

We are in **active development** on a local machine. The app is already deployed at `wheatley.cloud`, but we're iterating heavily on:
- **Performance**: Memory usage, frame times, LOD transitions, render spikes
- **Visual quality**: Skirt rendering, AO, texture transitions, anti-aliasing
- **Data pipeline**: The `waffle_iron.py` baker that converts DEM TIFs → binary hex tiles

### Tech Stack

| Layer | Technology | Key File(s) |
|-------|-----------|-------------|
| Frontend | Three.js (WebGL) + vanilla JS | `frontend/app/main.js` (1900 lines, the PistonViewer class) |
| Worker | Web Worker for tile parsing | `frontend/app/tile_worker.js` |
| LOD System | QuadTree + GridHash hybrid | `frontend/app/lod_controller.js` |
| Search | Nominatim geocoding + proj4 | `frontend/app/search.js` |
| Styling | Vanilla CSS, glassmorphism | `frontend/app/style.css` |
| Backend/Baker | Python (rasterio, numpy) | `hex_backend/waffle_iron.py` |
| Hosting | Static files on S3 via `wheatley.cloud` | — |


### How It Works

1. **Baker** (`waffle_iron.py`): Reads the 5m DEM TIF, generates hexagonal sectors. Each hex is packed into a binary. 

2. **Frontend** (`main.js`): The `PistonViewer` class manages:
   - **Instanced rendering**: One draw call per LOD layer (thousands of hexes per draw call)
   - **Various LOD levels with and without skirts **
   - **Sintering**: When the camera stops, the engine progressively upgrades to unit-resolution to save battery and upgrade resolution when static. The app boots into 2d Mode where the pistons haven't raised yet. 
   - **Skirt geometry**: Each hex "owns" its SE, S, SW edges to prevent overlapping geometry


3. **Worker** (`tile_worker.js`): Parses HEX4 binary, generates Float32Array buffers for instanced attributes, transfers them to the main thread via `postMessage` with transferables.

4. **LOD Controller** (`lod_controller.js`): Benchmarks three spatial index strategies (Linear, QuadTree, GridHash) and uses QuadTree results for actual rendering decisions.


### Running Locally

The `init_worktree.sh` script auto-assigns a free port when it creates your sandbox. Look for the `🔌 Dev server port:` line in the output. Use that port:

```bash
# Start a local server (use the port from the sandbox banner)
cd frontend/app
python3 -m http.server <PORT>

# Open in browser
# http://localhost:<PORT>
```

> **Why not 8080?** Multiple agents may run in parallel across playgrounds. Each sandbox gets a unique port to avoid collisions.

### Visual Testing & Feedback Loop

Two scripts work together for automated visual regression testing:

**1. Performance Profiler & Screenshot Capture** (`hive_assets/performance_profiler.js`)
Captures 4 phases of interaction (2D moving, 3D moving, sintering, static) along with CDP performance metrics, memory snapshots, and frame violation reports.

```bash
node hive_assets/performance_profiler.js [URL] [output_dir]
```

**2. Gemini Analysis** (`hive_assets/gemini_test.sh`)
Spawns a Gemini sub-agent as a feedback loop. The agent runs the profiler script, analyzes results, and answers specific questions about visual changes. Uses a shared Playwright MCP server only if screenshots are insufficient.

```bash
# Basic visual check (use your assigned port)
./hive_assets/gemini_test.sh http://localhost:<PORT>

# With specific question
./hive_assets/gemini_test.sh http://localhost:<PORT> --prompt "I changed skirt colors to hot pink, did it work?"
```

**Outputs**: Screenshots + `metrics.json` + `trace.zip` + `test_results.md` saved to `hive_assets/.test_results/` (gitignored). The Gemini agent outputs concise CLI feedback (token-efficient) while the detailed analysis lives in the MD file.

**Workflow for Primary Agents**: When you need visual feedback on a change, spawn this as a sub-agent. It runs isolated from your context, returns a brief answer, and preserves screenshots for your review if needed. 



### Running the Baker (Mini-Bake)

```bash
# From repo root:
./hex_backend/run_lil_bake.sh
# This bakes a 12x12 sector grid around Stubai Valley
```