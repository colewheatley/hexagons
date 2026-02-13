#!/bin/bash

# 🧇 Waffle Iron - Rapid Iteration Bake
# This script runs the default Mini-Bake logic (12x12 grid around Stubai)
# This is fast (~2-3 mins) and ideal for layout/texture testing.

# Ensure we are in the project root
cd "$(dirname "$0")/.."

echo "--------------------------------------------------"
echo "🧪 Starting PowFinder MINI-BAKE (Stubai 12x12)"
echo "Mode: Rapid Iteration"
echo "S3 Sync: DISABLED (Local Only)"
echo "Time: $(date)"
echo "--------------------------------------------------"

# Run the bake (defaults to mini-bake)
python3 -u hex_backend/waffle_iron.py 2>&1 | tee lil_bake_$(date +%Y%m%d_%H%M%S).log

echo "--------------------------------------------------"
echo "✅ Mini-Bake Complete."
echo "Map is ready for local testing in frontend/app/."
echo "--------------------------------------------------"
