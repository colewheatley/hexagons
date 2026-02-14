#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# Hexagons Worktree Initializer
# Creates a git worktree of the Hexagons project with symlinked assets.
#
# Usage:  ./init_worktree.sh <sandbox_name>
# Result: /Users/cole/dev/hive/<sandbox_name>/ is a lightweight git worktree
#         with all code files and symlinked heavy assets.
# ─────────────────────────────────────────────────────────────────────
set -e

REPO="/Users/cole/dev/Hexagons"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SANDBOX_ROOT="/Users/cole/dev/hive"

if [ -z "$1" ]; then
    echo "Usage: ./init_worktree.sh <sandbox_name>"
    echo "Example: ./init_worktree.sh fix_stutter_A"
    exit 1
fi

# Slugify: lowercase, replace non-alphanum with underscore
NAME=$(echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g' | sed 's/__*/_/g' | sed 's/^_//;s/_$//')
SANDBOX="$SANDBOX_ROOT/$NAME"
BRANCH="sandbox/$NAME"

if [ -d "$SANDBOX" ]; then
    echo "❌ Sandbox already exists: $SANDBOX"
    exit 1
fi

echo "🐝 Creating worktree sandbox: $SANDBOX"
echo "   Branch: $BRANCH"
echo ""

# Create parent dir
mkdir -p "$SANDBOX_ROOT"

# Create the git worktree from HEAD
cd "$REPO"
git worktree add -b "$BRANCH" "$SANDBOX" HEAD

# Copy hive_assets (since it's untracked by git, worktree add won't include it)
cp -r "$REPO/hive_assets" "$SANDBOX/"

echo "   ✅ Worktree created and hive_assets copied."

# ─────────────────────────────────────────────────────────────────────
# Symlink heavy assets (these are gitignored and NOT in the worktree)
# ─────────────────────────────────────────────────────────────────────

# TIF files (DEM + gradient cache)
for tif in "$REPO"/hex_backend/*.tif; do
    [ -f "$tif" ] && ln -sf "$tif" "$SANDBOX/hex_backend/$(basename "$tif")" 2>/dev/null
done
echo "   ✅ DEM TIFs symlinked."

# Aerial TIFs directory
if [ -d "$REPO/hex_backend/aerial_tifs" ]; then
    mkdir -p "$SANDBOX/hex_backend/aerial_tifs"
    ln -sf "$REPO"/hex_backend/aerial_tifs/* "$SANDBOX/hex_backend/aerial_tifs/" 2>/dev/null || true
    echo "   ✅ Aerial TIFs symlinked."
fi

# Aerial Downloader directory
if [ -d "$REPO/hex_backend/aerial_downloader" ]; then
    mkdir -p "$SANDBOX/hex_backend/aerial_downloader"
    ln -sf "$REPO"/hex_backend/aerial_downloader/* "$SANDBOX/hex_backend/aerial_downloader/" 2>/dev/null || true
    echo "   ✅ Aerial downloader symlinked."
fi

# Baked tile binaries
if [ -d "$REPO/frontend/app/tiles_bin" ]; then
    mkdir -p "$SANDBOX/frontend/app/tiles_bin"
    ln -sf "$REPO"/frontend/app/tiles_bin/* "$SANDBOX/frontend/app/tiles_bin/" 2>/dev/null || true
    echo "   ✅ Tile binaries symlinked."
fi

# Baked aerial tiles
if [ -d "$REPO/frontend/app/aerial_tiles" ]; then
    mkdir -p "$SANDBOX/frontend/app/aerial_tiles"
    ln -sf "$REPO"/frontend/app/aerial_tiles/* "$SANDBOX/frontend/app/aerial_tiles/" 2>/dev/null || true
    echo "   ✅ Aerial tiles symlinked."
fi

# Baked sectors
if [ -d "$REPO/hex_backend/baked_sectors" ]; then
    mkdir -p "$SANDBOX/hex_backend/baked_sectors"
    ln -sf "$REPO"/hex_backend/baked_sectors/* "$SANDBOX/hex_backend/baked_sectors/" 2>/dev/null || true
    echo "   ✅ Baked sectors symlinked."
fi

# node_modules
if [ -d "$REPO/node_modules" ]; then
    ln -sf "$REPO/node_modules" "$SANDBOX/node_modules"
    echo "   ✅ node_modules symlinked."
fi

# ─────────────────────────────────────────────────────────────────────
# Pick a free port so multiple sandboxes don't collide
# ─────────────────────────────────────────────────────────────────────
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🐝 SANDBOX READY: $SANDBOX"
echo "   🔌 Dev server port: $PORT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "To serve locally:  cd $SANDBOX/frontend/app && python3 -m http.server $PORT"
echo "To run tests:      cd $SANDBOX && node hive_assets/performance_profiler.js http://localhost:$PORT"
echo "To destroy:        cd $REPO && git worktree remove $SANDBOX --force && git branch -D $BRANCH"
