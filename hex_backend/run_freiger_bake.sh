#!/bin/bash
# Full-quality lossless bake for the 28 Freiger sectors.
# Uses freiger/orthos/source as the aerial directory.
# Run from project root: ./hex_backend/run_freiger_bake.sh

set -e
cd "$(dirname "$0")/.."

echo "--------------------------------------------------"
echo "🏔  Starting Freiger Hi-Res Bake"
echo "    Sectors: Q[77..80] × R[248..254] (28 tiles)"
echo "    Quality: lossless webp"
echo "    Aerial:  freiger/orthos/source"
echo "    Time:    $(date)"
echo "--------------------------------------------------"

pixi run python3 -u hex_backend/waffle_iron.py \
    --aerial-dir freiger/orthos/source \
    --range 77,80,248,254 \
    --lossless \
    --force \
    "$@" 2>&1 | tee freiger_bake_$(date +%Y%m%d_%H%M%S).log

echo "--------------------------------------------------"
echo "✅ Freiger bake complete."
echo "   Tiles written to frontend/app/tiles_bin/ and"
echo "   frontend/app/aerial_tiles/full/"
echo "--------------------------------------------------"
