# Hexagons — Code Bundle: backend
#
# Generated : 2026-04-28 14:06 UTC
# Repo root : /Users/cole/dev/Hexagons
# Files     : 7 included
# Est tokens: ~12,087
#
# File list:
#   hex_backend/coordinate_utility.py
#   hex_backend/generate_manifest.py
#   hex_backend/run_big_bake.sh
#   hex_backend/run_lil_bake.sh
#   hex_backend/test_gosper.py
#   hex_backend/test_gosper_js.mjs
#   hex_backend/waffle_iron.py
#
# ================================================================================


# ================================================================================
# FILE 1/7
# Path: hex_backend/coordinate_utility.py
# ================================================================================

# @atlas: Core coordinate mathematics and projection logic. Defines fundamental unit hex constants (32px, 0.2m/px), sector bounds (1024x1024 or 4096px, 819.2m), and provides utilities for converting between universal unit axial (q, r) and world meters (x, y) with standard flat-top orientation support.
import math
import numpy as np

# =============================================================================
# PIXEL-FIRST CONSTANTS (UNIT-BASED)
# =============================================================================
UNIT_HEX_PX = 32.0           # Exactly 32 pixels flat-to-flat
METERS_PER_PIXEL = 0.2       # The "Tirol Truth"

# Scale Factors (Visual / LOD)
UNIT_HEX_WIDTH_METERS = UNIT_HEX_PX * METERS_PER_PIXEL  # 6.4 meters exactly

# SECTOR DEFINITION (Rectangular Bins)
# User mentioned expecting 1024x1024.
# If we want the "High Res" (1/4 scale) to be exactly 1024px:
# 1024 * 4 = 4096 pixels for Full Res.
# 4096 pixels * 0.2 m/pixel = 819.2 meters.
SECTOR_SIZE_METERS = 819.2 
SECTOR_PIXELS = 4096 # 819.2 / 0.2

# Directions (Source of Truth: Flat Top, North Start, Clockwise)
NORTH = 0      # +r (Axial 0, 1)
NORTH_EAST = 1 # (Axial 1, 0)
SOUTH_EAST = 2 # (Axial 1, -1)
SOUTH = 3      # (Axial 0, -1)
SOUTH_WEST = 4 # (Axial -1, 0)
NORTH_WEST = 5 # (Axial -1, 1)

def get_hex_dimensions():
    """
    Returns the calculated dimensions of the hexes based on pixel constants.
    """
    return {
        'sector_width_m': SECTOR_SIZE_METERS,
        'unit_hex_width_m': UNIT_HEX_WIDTH_METERS,
        'unit_hex_radius_m': UNIT_HEX_WIDTH_METERS / math.sqrt(3),
        'pixels_per_unit_hex': UNIT_HEX_PX,
        'texture_size_px': SECTOR_PIXELS
    }

def axial_to_world_meters(q, r):
    """
    Converts Universal Unit Axial (q, r) to World Meters (x, y).
    Standard Flat Top Orientation:
    - q axis points ~East/South-East
    - r axis points North
    """
    h = UNIT_HEX_WIDTH_METERS
    world_x = (q * (math.sqrt(3)/2) * h)
    world_y = (r * h + q * 0.5 * h)
    return world_x, world_y
    
def world_meters_to_axial_approx(x, y):
    """
    Finds the nearest q,r for a given x,y.
    """
    h = UNIT_HEX_WIDTH_METERS
    A = (math.sqrt(3)/2 * h)
    q = x / A
    r = (y - (q * 0.5 * h)) / h
    return q, r 

def world_meters_to_axial_scale(x, y, s):
    """
    Finds the nearest q,r for a given x,y at Scale s.
    """
    eff_h = UNIT_HEX_WIDTH_METERS * s
    A = (math.sqrt(3)/2 * eff_h)
    q = x / A
    r = (y - (q * 0.5 * eff_h)) / eff_h
    return q, r 

def round_axial(q, r):
    x_cube = q
    z_cube = r
    y_cube = -q - r
    rx, ry, rz = round(x_cube), round(y_cube), round(z_cube)
    x_diff, y_diff, z_diff = abs(rx - x_cube), abs(ry - y_cube), abs(rz - z_cube)
    if x_diff > y_diff and x_diff > z_diff: rx = -ry - rz
    elif y_diff > z_diff: ry = -rx - rz
    else: rz = -rx - ry
    return int(rx), int(rz)

def world_to_sector_id(x, y):
    sx = math.floor(x / SECTOR_SIZE_METERS)
    sy = math.floor(y / SECTOR_SIZE_METERS)
    return sx, sy

def sector_id_to_bounds_meters(sx, sy):
    min_x = sx * SECTOR_SIZE_METERS
    min_y = sy * SECTOR_SIZE_METERS
    max_x = min_x + SECTOR_SIZE_METERS
    max_y = min_y + SECTOR_SIZE_METERS
    return min_x, min_y, max_x, max_y

def get_sector_center(sx, sy):
    min_x, min_y, max_x, max_y = sector_id_to_bounds_meters(sx, sy)
    return (min_x + max_x) * 0.5, (min_y + max_y) * 0.5

def get_hexes_in_bbox(min_x, max_x, min_y, max_y, padding_m=0.0):
    min_x -= padding_m
    max_x += padding_m
    min_y -= padding_m
    max_y += padding_m
    corners = [(min_x, min_y), (max_x, min_y), (max_x, max_y), (min_x, max_y)]
    qs, rs = [], []
    for cx, cy in corners:
        fq, fr = world_meters_to_axial_approx(cx, cy)
        qs.append(fq); rs.append(fr)
    for q in range(int(min(qs)) - 2, int(max(qs)) + 2):
        for r in range(int(min(rs)) - 2, int(max(rs)) + 2):
            wx, wy = axial_to_world_meters(q, r)
            if min_x <= wx <= max_x and min_y <= wy <= max_y: yield (q, r)

def get_lod_grid_hexes_in_bbox(min_x, max_x, min_y, max_y, scale_factor, padding_m=0.0):
    eff_h = UNIT_HEX_WIDTH_METERS * scale_factor
    A = (math.sqrt(3)/2 * eff_h)
    
    # STRICT BOUNDS: Do not use padding for Center Containment.
    # Otherwise neighboring sectors generate the same hex multiple times (overlap).
    # padding_m parameter is kept for signature compatibility but ignored for clipping.
    
    def to_prime(x, y):
         q = x / A
         r = (y - (q * 0.5 * eff_h)) / eff_h
         return q, r
    corners = [(min_x, min_y), (max_x, min_y), (max_x, max_y), (min_x, max_y)]
    qs, rs = [], []
    for cx, cy in corners:
        q, r = to_prime(cx, cy)
        qs.append(q); rs.append(r)
    found = []
    
    # Iterate a slightly wider integer range to catch edges, but strict clip on centers
    for q in range(int(min(qs)) - 2, int(max(qs)) + 2):
        for r in range(int(min(rs)) - 2, int(max(rs)) + 2):
            wx = q * dx_dq_scaled(scale_factor)
            wy = r * dy_dr_scaled(scale_factor) + q * dy_dq_scaled(scale_factor)
            
            # STRICT Check against Sector Bounds
            # Use < max to ensure exclusive upper bound (prevent double ownership at exact boundary)
            if min_x <= wx < max_x and min_y <= wy < max_y:
                found.append((q, r, wx, wy))
    return found

def dx_dq_scaled(s): return (math.sqrt(3)/2) * (UNIT_HEX_WIDTH_METERS * s)
def dy_dq_scaled(s): return 0.5 * (UNIT_HEX_WIDTH_METERS * s)
def dy_dr_scaled(s): return UNIT_HEX_WIDTH_METERS * s


# ================================================================================
# FILE 2/7
# Path: hex_backend/generate_manifest.py
# ================================================================================

# @atlas: Tile manifest generator. Scans the frontend's binary tiles directory for baked rectangular map sectors (.bin files) and compiles their coordinates and bounding boxes into a tile_manifest.json file to be consumed by the frontend engine for dynamic LOD loading.
import os
import json
import re
import sys
import coordinate_utility as coord_util

# CONFIG
BINARY_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../frontend/app/tiles_bin"))
OUTPUT_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), "../frontend/app/tile_manifest.json"))

def generate_manifest():
    print(f"🔍 Manifest Generator looking in: {BINARY_DIR}")
    
    if not os.path.exists(BINARY_DIR):
        print("❌ Error: Binary directory not found.")
        return

    files = os.listdir(BINARY_DIR)
    sectors = []
    
    # Pattern: sector_SX_SY.bin
    pattern = re.compile(r'sector_(-?\d+)_(-?\d+)\.bin')
    
    min_x = float('inf')
    min_y = float('inf')
    max_x = float('-inf')
    max_y = float('-inf')
    
    for f in files:
        match = pattern.match(f)
        if match:
            # Parse SX, SY
            SX = int(match.group(1))
            SY = int(match.group(2))
            
            # Convert to World Center
            cx, cy = coord_util.get_sector_center(SX, SY)
            
            # Append to list
            # We map sx->q, sy->r for compatibility with frontend structure
            sectors.append({
                'q': SX,
                'r': SY,
                'x': cx,
                'y': cy
            })
            
            if cx < min_x: min_x = cx
            if cx > max_x: max_x = cx
            if cy < min_y: min_y = cy
            if cy > max_y: max_y = cy
            
    # Calculate approx bounds size for camera
    margin = 2000.0
    
    # Handle empty case
    if min_x == float('inf'):
        min_x = 0
        max_x = 0
        min_y = 0
        max_y = 0
            
    manifest = {
        'tiles': sectors, 
        'type': 'sector_rect',
        'bounds': {
            'min_x': min_x - margin,
            'max_x': max_x + margin,
            'min_y': min_y - margin,
            'max_y': max_y + margin
        },
        'sector_size_m': coord_util.SECTOR_SIZE_METERS
    }
    
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(manifest, f, indent=4)
        
    print(f"✅ Generated manifest for {len(sectors)} rectangular sectors.")
    print(f"   Bounds: X[{min_x:.0f}, {max_x:.0f}], Y[{min_y:.0f}, {max_y:.0f}]")
    print(f"   Saved to: {OUTPUT_FILE}")

if __name__ == "__main__":
    generate_manifest()


# ================================================================================
# FILE 3/7
# Path: hex_backend/run_big_bake.sh
# ================================================================================

#!/bin/bash
# @atlas: Orchestration script for the 'Overnight Super-Bake'. Executes the full geographic expansion via waffle_iron.py and synchronizes the resulting baked binary tiles and textures to the live S3 bucket (wheatley.cloud).
# 🧇 Waffle Iron Overnight Super-Bake & S3 Sync
# This script runs the full geographic expansion and uploads tiles live to wheatley.cloud

# Ensure we are in the project root
cd "$(dirname "$0")/.."

echo "--------------------------------------------------"
echo "🚀 Starting PowFinder Global Bake & S3 Sync"
echo "Bucket: wheatley.cloud"
echo "Time: $(date)"
echo "--------------------------------------------------"

# Check for AWS CLI
if ! command -v aws &> /dev/null; then
    echo "❌ Error: AWS CLI not found. Please install it first."
    exit 1
fi

# Run the bake
# We use stdbuf to ensure python output isn't buffered so we can tail the log
python3 -u hex_backend/waffle_iron.py --full 2>&1 | tee bake_log_$(date +%Y%m%d_%H%M%S).log

echo "--------------------------------------------------"
echo "✅ Bake Complete."
echo "Check the log file for details."
echo "--------------------------------------------------"


# ================================================================================
# FILE 4/7
# Path: hex_backend/run_lil_bake.sh
# ================================================================================

#!/bin/bash
# @atlas: Orchestration script for rapid iteration local testing. Triggers a small-scale (e.g. 12x12 grid) 'Mini-Bake' focused around Stubai using waffle_iron.py, specifically disabling S3 synchronization to allow for quick frontend layout and texture tuning.
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

# Run the bake (passes through args like --center or --force)
python3 -u hex_backend/waffle_iron.py "$@" 2>&1 | tee lil_bake_$(date +%Y%m%d_%H%M%S).log

echo "--------------------------------------------------"
echo "✅ Mini-Bake Complete."
echo "Map is ready for local testing in frontend/app/."
echo "--------------------------------------------------"


# ================================================================================
# FILE 5/7
# Path: hex_backend/test_gosper.py
# ================================================================================

#!/usr/bin/env python3
# @atlas: Command-line diagnostic script. Generates and prints Gosper curve coordinate offsets (specifically at recursion Level 5) by invoking the Python coordinate_utility matrix math. Crucial for verifying that the backend spatial logic matches the frontend visualization exactly.
"""Quick test to print Gosper offsets for comparison with JavaScript."""

import coordinate_utility as coord_util

if __name__ == "__main__":
    print("Generating Gosper offsets at Level 5...")
    offsets = coord_util.generate_gosper_offsets(5, debug=True)
    print(f"\nDone. Generated {len(offsets)} offsets.")


# ================================================================================
# FILE 6/7
# Path: hex_backend/test_gosper_js.mjs
# ================================================================================

// @atlas: Node.js diagnostic script that mirrors the Python backend's recursive Gosper curve generator. Simulates the specific 7-neighbor matrix shifting algorithms up to Level 5, allowing developers to diff the generated offsets against the Python output and ensure the hex rendering grid aligns flawlessly.
// Quick test to verify JavaScript Gosper offsets match Python

function generateGosperOffsets(level) {
    if (level === 0) return [{ q: 0, r: 0 }];

    const prevOffsets = generateGosperOffsets(level - 1);

    const applyMatrixPower = (q, r, power) => {
        for (let i = 0; i < power; i++) {
            const nq = 2 * q + 1 * r;
            const nr = -1 * q + 3 * r;
            q = nq;
            r = nr;
        }
        return { q, r };
    };

    // MUST match Python exactly
    const neighbors = [
        { q: 0, r: 0 },
        { q: 1, r: 0 },
        { q: 1, r: -1 },
        { q: 0, r: -1 },
        { q: -1, r: 0 },
        { q: -1, r: 1 },
        { q: 0, r: 1 }
    ];

    const finalList = [];

    for (let i = 0; i < 7; i++) {
        const baseShift = neighbors[i];
        const shift = applyMatrixPower(baseShift.q, baseShift.r, level - 1);

        if (level === 5) {
            console.log(`Level ${level}, neighbor ${i}: base(${baseShift.q},${baseShift.r}) -> shift(${shift.q},${shift.r})`);
        }

        for (const p of prevOffsets) {
            finalList.push({
                q: p.q + shift.q,
                r: p.r + shift.r
            });
        }
    }

    return finalList;
}

console.log("=== JAVASCRIPT GOSPER OFFSET TEST ===\n");
const offsets = generateGosperOffsets(5);

console.log("\n=== JAVASCRIPT GOSPER OFFSET DEBUG ===");
console.log("First 7 offsets:", offsets.slice(0, 7).map(o => `(${o.q},${o.r})`).join(", "));
console.log("Offsets 2401-2407:", offsets.slice(2401, 2408).map(o => `(${o.q},${o.r})`).join(", "));
console.log("Last 7 offsets:", offsets.slice(-7).map(o => `(${o.q},${o.r})`).join(", "));
console.log("Total offsets:", offsets.length);


# ================================================================================
# FILE 7/7
# Path: hex_backend/waffle_iron.py
# ================================================================================

# @atlas: The central terrain baking pipeline ('Waffle Iron' v4.1). Ingests large EPSG:31254 DEMs and high-res orthophotos (TIFs). It processes these into a proprietary 16-byte 'Uber-Hex' binary structure (.bin) featuring delta compression, 'Diamond' slope area sampling, and packed lighting normals. Simultaneously generates and uploads padded webp tiles (full and low-res LODs) to S3, using incremental caching to prevent redundant bakes.
# 🧇 Waffle Iron v4.1 - Incremental Bake Edition
# =============================================================================
# FEATURES:
#   - 16-Byte "Uber-Hex" Layout (Power-of-Two aligned)
#   - Gapless "Partial Skirt" Topology (SE, S, SW ownership)
#   - "Diamond" Area Sampling for faithful edge slopes
#   - Baked-in Center Normals (Nx, Nz) for smooth Cap lighting
#   - Int16 Vertical Deltas (Decimeter precision)
#   - Incremental baking with BAKER_VERSION skip logic
#   - Configurable grid size (--grid 1..16) and center (--center Q,R)
#   - Regional DEM/gradient cache for mini-bake (memory-efficient)
#
# DATA SPECS (files NOT in git — too large):
#   Aerial TIFs:     3,486 files, 2.4–12.9 MB each (avg 7.2 MB), 24.6 GB total
#                    RGB orthophotos, EPSG:31254, ~0.2m/px
#   DEM:             DGM_Tirol_5m_epsg31254_2006_2020.tif
#                    1.1 GB on disk, 4.85 GB uncompressed (26612×45538, float32, 5m res)
#   Gradient Cache:  DGM_Tirol_gradient_cached.tif
#                    14 GB on disk, 38.78 GB uncompressed (53224×91076, 2 bands float32)
#                    Generated on first run from the DEM (2× upsampled dx/dy gradients)
#
# OUTPUT FORMATS (baked per-sector, also NOT in git):
#   .bin:   HEX4 header + 4 LOD layers of packed 16-byte records
#           Each record: dq(b) dr(b) h(H) d1(h) d2(h) d3(h) s1(B) s2(B) s3(B) nx(B) nz(B) pad(x)
#   .webp:  Aerial texture with 64px padding for seamless tile blending
#           Saved at full res + 1/16 "low" res for LOD streaming
#
# HARDWARE PROFILE (reference machine):
#   MacBook M1, 16 GB shared memory
#   Mini-bake 12×12 (144 sectors): ~11 min  |  avg 4.6s/sector
#   Mini-bake regional cache: ~19 MB DEM + ~149 MB gradient (vs 1.1 GB + 14 GB full)
# =============================================================================

import os
import glob
import math
import time
import json
import numpy as np
import rasterio
import rasterio.enums
import rasterio.windows
import gc
import re
from shapely.geometry import Polygon, box
import argparse
import shutil
import sys
import struct
from pyproj import Transformer

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import coordinate_utility as coord_util
import generate_manifest

def latlon_to_world_meters(lat, lon):
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:31254", always_xy=True)
    return transformer.transform(lon, lat)

# =============================================================================
# GLOBAL CONFIG (Modified by args)
# =============================================================================
S3_ENABLED = False # Default to False
S3_BUCKET = "wheatley.cloud"
S3_PREFIX = "powfinder/app"

# =============================================================================
# CONSTANTS & CONFIGURATION
# =============================================================================
TEXTURE_PADDING_PX = 64  
WEB_P_QUALITY = 10
DEBUG_MODE = False

# Stubai Center (For Mini-Bake) — precise coordinates for sector (73, 252)
STUBAI_LAT = 46.996315457481984
STUBAI_LON = 11.119477646985764

BAKER_VERSION = "4.1.0"  # bump this when you change baking logic to trigger re-bake

DEFAULT_GRID_SIZE = 12  # 12×12 grid for mini-bake (configurable via --grid)

DEM_PATH = "hex_backend/DGM_Tirol_5m_epsg31254_2006_2020.tif"
GRADIENT_PATH = "hex_backend/DGM_Tirol_gradient_cached.tif"
AERIAL_DIR = "hex_backend/aerial_tifs"
METADATA_PATH = "frontend/app/tiles_bin/metadata.json"

def upload_to_s3(local_path):
    """
    Uploads a file to S3 immediately.
    Maps local 'frontend/app/...' to S3 'powfinder/app/...'
    """
    if not S3_ENABLED: return
    
    # Standardize path
    local_path = os.path.normpath(local_path)
    
    # Find relative path from the app root
    # local_path is like /Users/.../frontend/hexagons/app/tiles_bin/sector_1_2.bin
    # We want the part after 'hexagons/app/'
    parts = local_path.split(os.sep)
    try:
        idx = parts.index("app")
        rel_path = "/".join(parts[idx+1:])
    except ValueError:
        rel_path = os.path.basename(local_path)

    s3_url = f"s3://{S3_BUCKET}/{S3_PREFIX}/{rel_path}"
    
    cmd = ["aws", "s3", "cp", local_path, s3_url, "--quiet"]
    
    # Set Cache-Control for immutable assets
    if local_path.endswith(('.webp', '.bin')):
        cmd += ["--cache-control", "max-age=31536000"]
        
    try:
        # Launch in background, do not wait
        subprocess.Popen(cmd)
    except Exception as e:
        print(f"⚠️  S3 Upload failed for {local_path}: {e}")

# =============================================================================
# BAKING FUNCTIONS
# =============================================================================

def get_or_create_gradient_map(dem_path, output_path, upsample_factor=1):
    """
    Generates a 2-Band Float32 TIF containing terrain gradients (dx, dy).
    Band 1: dx (Slope in X direction)
    Band 2: dy (Slope in Y direction)
    Used to derive Slope, Aspect, and Normals on the fly.
    """
    if os.path.exists(output_path):
        print(f"✅ Found cached gradient map: {output_path}")
        return rasterio.open(output_path)

    print(f"⚠️  Gradient map not found. Generating from {dem_path}...")
    start_time = time.time()

    with rasterio.open(dem_path) as src:
        new_width = src.width * upsample_factor
        new_height = src.height * upsample_factor
        
        new_transform = src.transform * src.transform.scale(
            (src.width / new_width),
            (src.height / new_height)
        )

        profile = src.profile.copy()
        profile.update(
            dtype=rasterio.float32, 
            count=2, # Two bands: dx, dy
            driver='GTiff',
            width=new_width,
            height=new_height,
            transform=new_transform,
            compress='lzw',
            tiled=True,
            blockxsize=512,
            blockysize=512,
            predictor=3,
            BIGTIFF='YES'
        )
        
        res_x = abs(new_transform[0])
        res_y = abs(new_transform[4])

        print(f"   -> Processing Gradients (Total: {new_width}x{new_height}, Res: {res_x:.2f}m)...")
        
        with rasterio.open(output_path, 'w', **profile) as dst:
            for jt, window in dst.block_windows(1):
                pad = 2
                src_window = rasterio.windows.Window(
                    window.col_off / upsample_factor - pad,
                    window.row_off / upsample_factor - pad,
                    window.width / upsample_factor + 2*pad,
                    window.height / upsample_factor + 2*pad
                ).intersection(rasterio.windows.Window(0, 0, src.width, src.height))
                
                chunk_dem = src.read(
                    1, 
                    window=src_window, 
                    out_shape=(int(src_window.height * upsample_factor), int(src_window.width * upsample_factor)),
                    resampling=rasterio.enums.Resampling.lanczos
                )
                
                if chunk_dem.size == 0: continue

                # Calculate Gradients
                # np.gradient returns (gradient_axis_0, gradient_axis_1) -> (dy, dx)
                dy, dx = np.gradient(chunk_dem, res_y, res_x)
                
                # Careful with signage: raster rows increase DOWN (-Y), but index increases UP?
                # Usually DEMs are top-left origin. +Row = -Y.
                # So gradient in row index is -dy/dPixel.
                # We want standard world space (dx, dy).
                # If TIF transform is standard (dy negative), we need to account for it.
                # simpler: keep them as raster-space gradients and handle "World Z" later?
                # Let's store pure geometric gradients: dZ/dWorldX, dZ/dWorldY.
                # If dy is negative in transform (N->S), then pixel_y+1 is South.
                # np.gradient gives change per index step.
                # if row i -> i+1 is moving South (lower Y), and logic is (z[i+1]-z[i]).
                # That is dZ / d(-Y). So dZ/dY = -(z[i+1]-z[i]) / step.
                # We passed positive step sizes (res_y, res_x) to np.gradient.
                # So `dy` output from np.gradient is dZ per Meter-Down-Screen.
                # That equals -dZ/dY.
                # So stored band 2 should be -dy.
                
                real_dy = -dy 
                real_dx = dx # X usually increases right, same as col index.
                
                # Crop encoding logic
                off_x = int(round(window.col_off - (src_window.col_off * upsample_factor)))
                off_y = int(round(window.row_off - (src_window.row_off * upsample_factor)))
                
                h, w = window.height, window.width
                
                final_dx = real_dx[off_y:off_y+int(h), off_x:off_x+int(w)]
                final_dy = real_dy[off_y:off_y+int(h), off_x:off_x+int(w)]
                
                dst.write(final_dx, 1, window=window)
                dst.write(final_dy, 2, window=window)
                
                if jt[0] % 20 == 0 and jt[1] == 0:
                    current_block = jt[0] * (dst.width // 512 + 1) + jt[1]
                    # print(f"   -> Progress...") 

    print(f"✅ Generated Gradient Map in {time.time() - start_time:.2f}s")
    return rasterio.open(output_path)

def generate_regional_gradient(dem_ds, bounds, upsample_factor=2, output_path="hex_backend/mini_bake_gradient.tif"):
    """
    Generate a small gradient TIF covering only the specified bounding box.
    Much faster and lighter than the full Tirol gradient cache (~150MB vs 14GB).
    Args:
        dem_ds: already-opened rasterio DEM dataset
        bounds: (min_x, min_y, max_x, max_y) in DEM CRS
        upsample_factor: resolution multiplier (2 = 2.5m from 5m DEM)
        output_path: where to write the gradient TIF
    """
    padding_m = 500.0  # extra padding for edge gradients
    min_x, min_y, max_x, max_y = bounds
    
    # Read the DEM window with padding
    dem_window = rasterio.windows.from_bounds(
        min_x - padding_m, min_y - padding_m,
        max_x + padding_m, max_y + padding_m, dem_ds.transform)
    dem_window = dem_window.intersection(
        rasterio.windows.Window(0, 0, dem_ds.width, dem_ds.height))
    
    out_h = int(dem_window.height * upsample_factor)
    out_w = int(dem_window.width * upsample_factor)
    
    print(f"   Generating regional gradient ({out_w}×{out_h} px)...")
    t0 = time.time()
    
    chunk_dem = dem_ds.read(
        1, window=dem_window,
        out_shape=(out_h, out_w),
        resampling=rasterio.enums.Resampling.lanczos)
    
    # Compute transform for the output
    win_transform = dem_ds.window_transform(dem_window)
    out_transform = win_transform * win_transform.scale(
        dem_window.width / out_w, dem_window.height / out_h)
    
    res_x = abs(out_transform[0])
    res_y = abs(out_transform[4])
    
    dy, dx = np.gradient(chunk_dem, res_y, res_x)
    real_dy = -dy  # flip for world-space Y
    real_dx = dx
    
    profile = dem_ds.profile.copy()
    profile.update(
        dtype=rasterio.float32, count=2, driver='GTiff',
        width=out_w, height=out_h, transform=out_transform,
        compress='lzw', tiled=True, blockxsize=256, blockysize=256,
        predictor=3)
    
    with rasterio.open(output_path, 'w', **profile) as dst:
        dst.write(real_dx, 1)
        dst.write(real_dy, 2)
    
    elapsed = time.time() - t0
    size_mb = os.path.getsize(output_path) / 1e6
    print(f"   ✅ Regional gradient: {size_mb:.1f} MB in {elapsed:.1f}s")
    return rasterio.open(output_path)

def bake_sector_textures(SX, SY, valid_tifs, output_dir="frontend/app/aerial_tiles"):
    import PIL.Image as Image
    from rasterio.windows import from_bounds
    if not os.path.exists(output_dir): os.makedirs(output_dir)

    min_x, min_y, max_x, max_y = coord_util.sector_id_to_bounds_meters(SX, SY)
    padding_m = TEXTURE_PADDING_PX * coord_util.METERS_PER_PIXEL
    padded_min_x, padded_max_x = min_x - padding_m, max_x + padding_m
    padded_min_y, padded_max_y = min_y - padding_m, max_y + padding_m
    
    total_size_px = coord_util.SECTOR_PIXELS + (TEXTURE_PADDING_PX * 2)
    target_poly = box(padded_min_x, padded_min_y, padded_max_x, padded_max_y)

    canvas = Image.new("RGB", (total_size_px, total_size_px), (0, 0, 0))
    intersecting = [t for t in valid_tifs if t["poly"].intersects(target_poly)]

    for t in intersecting:
        with rasterio.open(t["path"]) as src:
            ix_min_x, ix_max_x = max(padded_min_x, src.bounds.left), min(padded_max_x, src.bounds.right)
            ix_min_y, ix_max_y = max(padded_min_y, src.bounds.bottom), min(padded_max_y, src.bounds.top)
            if ix_min_x >= ix_max_x or ix_min_y >= ix_max_y: continue

            window = from_bounds(ix_min_x, ix_min_y, ix_max_x, ix_max_y, src.transform)
            w_px = int((ix_max_x - ix_min_x) / coord_util.METERS_PER_PIXEL)
            h_px = int((ix_max_y - ix_min_y) / coord_util.METERS_PER_PIXEL)
            if w_px <= 0 or h_px <= 0: continue

            try:
                data = src.read(window=window, out_shape=(src.count, h_px, w_px), resampling=rasterio.enums.Resampling.lanczos)
                patch = Image.fromarray(np.moveaxis(data, 0, -1).astype("uint8"), "RGB")
                px = int((ix_min_x - padded_min_x) / coord_util.METERS_PER_PIXEL)
                py = int((padded_max_y - ix_max_y) / coord_util.METERS_PER_PIXEL)
                canvas.paste(patch, (px, py))
            except: pass

    res_dirs = { k: os.path.join(output_dir, k) for k in ["full", "low"] }
    for d in res_dirs.values():
        if not os.path.exists(d): os.makedirs(d)

    f_name = f"sector_{SX}_{SY}.webp"
    full_path = os.path.join(res_dirs["full"], f_name)
    low_path = os.path.join(res_dirs["low"], f_name)

    canvas.save(full_path, "WEBP", quality=WEB_P_QUALITY)
    upload_to_s3(full_path)

    c_low = canvas.resize((total_size_px // 16, total_size_px // 16), Image.LANCZOS)
    c_low.save(low_path, "WEBP", quality=WEB_P_QUALITY)
    upload_to_s3(low_path)

def get_diamond_stats(grad_ds, p1, p2):
    """
    Samples the gradient map in the bounding box of the edge (p1 to p2).
    Returns averaged slope (deg).
    p1, p2 are tuples (wx, wy).
    """
    min_x, max_x = min(p1[0], p2[0]), max(p1[0], p2[0])
    min_y, max_y = min(p1[1], p2[1]), max(p1[1], p2[1])
    
    # Add minimal buffer to ensure we catch a pixel
    min_x -= 1.0; max_x += 1.0
    min_y -= 1.0; max_y += 1.0
    
    window = rasterio.windows.from_bounds(min_x, min_y, max_x, max_y, grad_ds.transform)
    
    # Read Band 1 (dx) and Band 2 (dy)
    # Clip window to image
    window = window.intersection(rasterio.windows.Window(0, 0, grad_ds.width, grad_ds.height))
    
    if window.width < 1 or window.height < 1: return 0
    
    dx_vals = grad_ds.read(1, window=window)
    dy_vals = grad_ds.read(2, window=window)
    
    if dx_vals.size == 0: return 0
    
    # Average Gradient Vector
    avg_dx = np.mean(dx_vals)
    avg_dy = np.mean(dy_vals)
    
    # Convert to Slope
    slope_rad = math.atan(math.sqrt(avg_dx*avg_dx + avg_dy*avg_dy))
    slope_deg = math.degrees(slope_rad)
    return slope_deg

def bake_sector_binary(SX, SY, dem_ds, grad_ds, output_dir="frontend/app/tiles_bin"):
    if not os.path.exists(output_dir): os.makedirs(output_dir)
    min_x, min_y, max_x, max_y = coord_util.sector_id_to_bounds_meters(SX, SY)

    scales = [{"id": 3, "s": 24.0}, {"id": 2, "s": 6.0}, {"id": 1, "s": 3.0}, {"id": 0, "s": 1.0}]
    layers_data, min_z, max_z = [], 9999, -9999
    
    center_wx, center_wy = coord_util.get_sector_center(SX, SY)
    cq, cr = [int(round(v)) for v in coord_util.world_meters_to_axial_approx(center_wx, center_wy)]

    # --- READ DEM WINDOW for this sector ---
    padding_m = 200.0  # meters of padding for neighbor height samples
    dem_window = rasterio.windows.from_bounds(
        min_x - padding_m, min_y - padding_m,
        max_x + padding_m, max_y + padding_m, dem_ds.transform)
    dem_window = dem_window.intersection(rasterio.windows.Window(0, 0, dem_ds.width, dem_ds.height))
    dem_data = dem_ds.read(1, window=dem_window)
    dem_transform = dem_ds.window_transform(dem_window)

    # --- READ GRADIENT WINDOW for this sector ---
    padding_g = 200.0
    g_window = rasterio.windows.from_bounds(min_x-padding_g, min_y-padding_g, max_x+padding_g, max_y+padding_g, grad_ds.transform)
    g_window = g_window.intersection(rasterio.windows.Window(0,0,grad_ds.width, grad_ds.height))
    
    # We will read this into memory: (2, H, W)
    sector_grads = grad_ds.read(window=g_window)
    sector_grad_transform = grad_ds.window_transform(g_window)
    
    # Pre-calculate center slopes/normals for the block?
    # Actually, let's keep the diamond stats lightweight by indexing into this array
    
    def fast_diamond_slope(wx1, wy1, wx2, wy2):
        # Map to array indices
        r1, c1 = rasterio.transform.rowcol(sector_grad_transform, wx1, wy1)
        r2, c2 = rasterio.transform.rowcol(sector_grad_transform, wx2, wy2)
        
        r_min, r_max = min(r1, r2), max(r1, r2)
        c_min, c_max = min(c1, c2), max(c1, c2)
        
        # Ensure slice is valid
        r_min = max(0, r_min); r_max = min(sector_grads.shape[1], r_max + 1)
        c_min = max(0, c_min); c_max = min(sector_grads.shape[2], c_max + 1)
        
        if r_max <= r_min or c_max <= c_min: return 0
        
        sub_dx = sector_grads[0, r_min:r_max, c_min:c_max]
        sub_dy = sector_grads[1, r_min:r_max, c_min:c_max]
        
        mdx = np.mean(sub_dx)
        mdy = np.mean(sub_dy)
        return math.degrees(math.atan(math.sqrt(mdx*mdx + mdy*mdy)))

    def get_center_normal_packed(wx, wy):
        r, c = rasterio.transform.rowcol(sector_grad_transform, wx, wy)
        r = max(0, min(sector_grads.shape[1]-1, r))
        c = max(0, min(sector_grads.shape[2]-1, c))
        dx = sector_grads[0, r, c]
        dy = sector_grads[1, r, c]
        
        # Normal = (-dx, -dy, 1) normalized
        length = math.sqrt(dx*dx + dy*dy + 1)
        nx = -dx / length
        nz = -dy / length
        # ny = 1 / length (implicit)
        
        # Pack to 0-255 (range -1 to 1)
        # 128 is 0. 
        px = int((nx * 127.0) + 128.0)
        pz = int((nz * 127.0) + 128.0)
        return max(0, min(255, px)), max(0, min(255, pz))


    for l in scales:
        S = l["s"]
        lcq, lcr = [int(round(v)) for v in coord_util.world_meters_to_axial_scale(center_wx, center_wy, S)]
        hx = coord_util.get_lod_grid_hexes_in_bbox(min_x, max_x, min_y, max_y, S)
        
        if hx:
            # 1. Gather Heights (Vectorized)
            w_h = coord_util.UNIT_HEX_WIDTH_METERS * S
            dx_dq = (math.sqrt(3)/2) * w_h
            dy_dq = 0.5 * w_h
            dy_dr = w_h 
            
            c_wx = np.array([h[2] for h in hx])
            c_wy = np.array([h[3] for h in hx])
            
            # Neighbors for Delta Calculation
            # 2=SE, 3=S, 4=SW (Axial Deltas: SE(1, -1), S(0, -1), SW(-1, 0))
            # Also for Skirts we need to know WHERE the neighbor center is.
            offsets = [
                (1, -1), # SE
                (0, -1), # S
                (-1, 0)  # SW
            ]
            
            # Sample Center Heights
            rows, cols = rasterio.transform.rowcol(dem_transform, c_wx, c_wy)
            rows = np.clip(rows, 0, dem_data.shape[0]-1)
            cols = np.clip(cols, 0, dem_data.shape[1]-1)
            c_h = dem_data[rows, cols]
            
            min_z, max_z = min(min_z, c_h.min()), max(max_z, c_h.max())
            
            layer = []
            
            for i in range(len(hx)):
                q, r = hx[i][0], hx[i][1]
                wx, wy = c_wx[i], c_wy[i]
                h_val = c_h[i]
                
                # Sample Normal (Center)
                nx_p, nz_p = get_center_normal_packed(wx, wy)
                
                # --- PROCESS OWNED EDGES ---
                deltas = []
                slopes = []
                
                for (dq_o, dr_o) in offsets:
                    # Neighbor Coord
                    nq, nr = q + dq_o, r + dr_o
                    
                    # Neighbor World Pos
                    nwx = wx + (dq_o * dx_dq) # Rough approx for grid, accurate for relative
                    # Recalculate exact world pos to be safe
                    # Actually, c_wx + (offset) is cleaner.
                    # SE offset: dq=1, dr=-1.
                    odx = dq_o * dx_dq
                    ody = dr_o * dy_dr + dq_o * dy_dq
                    nwx = wx + odx
                    nwy = wy + ody
                    
                    # Sample Neighbor Height
                    nr_r, nc_c = rasterio.transform.rowcol(dem_transform, nwx, nwy)
                    nr_r = max(0, min(dem_data.shape[0]-1, nr_r))
                    nc_c = max(0, min(dem_data.shape[1]-1, nc_c))
                    nh_val = dem_data[nr_r, nc_c]
                    
                    # Delta (Decimeters)
                    d_m = h_val - nh_val
                    
                    # SANITY CHECK: If neighbor is >400m away vertically, it's likely NODATA/Edge of Map.
                    # Clamp to 0 (Flat Skirt) to avoid visual spikes.
                    if abs(d_m) > 400.0: d_m = 0.0
                    
                    deltas.append(int(round(d_m * 10.0)))
                    
                    # Diamond Slope (Between wx,wy and nwx,nwy)
                    # Use fast lookup in memory
                    s_edge = fast_diamond_slope(wx, wy, nwx, nwy)
                    slopes.append(int(round(s_edge)))
                
                layer.append({
                    'q': q, 'r': r,
                    'deltas': deltas, # [SE, S, SW] in Decimeters
                    'slopes': slopes, # [SE, S, SW] in Degrees
                    'h': h_val,
                    'lcq': lcq, 'lcr': lcr,
                    'pnx': nx_p, 'pnz': nz_p
                })
            
            layers_data.append(layer)
        else: layers_data.append([])

    scale_f = 65535.0 / (max_z - min_z + 20) if max_z > min_z else 1.0
    # Signature HEX4 denotes new 16-byte layout
    blob = struct.pack("<4siifffii", b"HEX4", int(SX), int(SY), float(min_z-10), float(max_z+10), float(scale_f), cq, cr)
    
    for l_idx, ld in enumerate(layers_data):
        blob += struct.pack("<I", len(ld))
        buf = bytearray(len(ld) * 16) # 16 BYTES!
        
        for i, item in enumerate(ld):
            dq = max(-127, min(127, int(item['q'] - item['lcq'])))
            dr = max(-127, min(127, int(item['r'] - item['lcr'])))
            h_scaled = max(0, min(65535, int((item['h'] - (min_z-10)) * scale_f)))
            
            d1, d2, d3 = item['deltas']
            d1 = max(-32767, min(32767, d1))
            d2 = max(-32767, min(32767, d2))
            d3 = max(-32767, min(32767, d3))
            
            s1, s2, s3 = item['slopes']
            s1 = max(0, min(255, s1))
            s2 = max(0, min(255, s2))
            s3 = max(0, min(255, s3))
            
            pnx = item['pnx']
            pnz = item['pnz']
            
            # STRUCT:
            # 0: dq (b)
            # 1: dr (b)
            # 2: h (H)
            # 4: d1 (h)
            # 6: d2 (h)
            # 8: d3 (h)
            # 10: s1 (B)
            # 11: s2 (B)
            # 12: s3 (B)
            # 13: pnx (B)
            # 14: pnz (B)
            # 15: pad (x)
            
            struct.pack_into("<bbHhhhBBBBBx", buf, i*16, 
                             dq, dr, h_scaled, 
                             d1, d2, d3, 
                             s1, s2, s3, 
                             pnx, pnz)
            
            # Note: format string `<bbHhhhBBBxB` 
            # b=1, b=1, H=2 (4), h=2 (6), h=2 (8), h=2 (10), B=1 (11), B=1 (12), B=1 (13), x=1 (14), B=1 (15)? 
            # Wait. 
            # offset 0: b
            # offset 1: b
            # offset 2: H -> Ends at 4.
            # offset 4: h -> Ends at 6.
            # offset 6: h -> Ends at 8.
            # offset 8: h -> Ends at 10.
            # offset 10: B -> 11
            # offset 11: B -> 12
            # offset 12: B -> 13
            # offset 13: B (nx) -> 14
            # offset 14: B (nz) -> 15
            # offset 15: pad
            
            # Format: 'bbHhhhBBBBBx' ?
            # Python struct: x is pad byte.
            # Let's be explicit with B.
            struct.pack_into("<bbHhhhBBBBBx", buf, i*16,
                             dq, dr, h_scaled,
                             d1, d2, d3,
                             s1, s2, s3,
                             pnx, pnz) # Last byte is 'x' (pad), no arg needed.

        blob += buf
    
    bin_path = os.path.join(output_dir, f"sector_{SX}_{SY}.bin")
    with open(bin_path, "wb") as f: 
        f.write(blob)
    upload_to_s3(bin_path)

def main():
    global S3_ENABLED
    parser = argparse.ArgumentParser(description="🧇 Waffle Iron v4.1 — Incremental Bake")
    parser.add_argument("--full", action="store_true", help="Run full global bake (defaults to Mini-Bake)")
    parser.add_argument("--center", type=str, help="Center sector as 'Q,R' (e.g. 73,252)")
    parser.add_argument("--grid", type=int, default=DEFAULT_GRID_SIZE,
                        help=f"Grid size NxN around center (1-16, default {DEFAULT_GRID_SIZE})")
    parser.add_argument("--force", action="store_true", help="Force re-bake of all sectors in range")
    args = parser.parse_args()

    # Validate grid size
    grid_size = max(1, min(16, args.grid))

    # Load existing metadata for skip logic
    metadata = {}
    if os.path.exists(METADATA_PATH):
        try:
            with open(METADATA_PATH, "r") as f:
                metadata = json.load(f)
        except: pass
    
    prev_version = metadata.get("baker_version", "")
    can_skip = (prev_version == BAKER_VERSION) and not args.force
    if can_skip:
        print(f"🔄 Incremental bake: BAKER_VERSION {BAKER_VERSION} matches. Will skip existing tiles.")
    elif args.force:
        print(f"🔥 Force re-bake enabled.")
    else:
        print(f"✨ New baker version detected ({prev_version} -> {BAKER_VERSION}). Re-baking everything in range.")

    # Disk Space Check
    import shutil as disk_check
    total, used, free = disk_check.disk_usage("/")
    free_gb = free / (1024**3)
    if free_gb < 5.0:
        print(f"⚠️  WARNING: Only {free_gb:.1f}GB of free disk space available!")
        print(f"   The bake may fail if disk fills up. Consider freeing space first.")
        response = input("   Continue anyway? (y/N): ")
        if response.lower() != 'y':
            print("Aborting.")
            return

    if args.full:
        print("🚀 RUNNING FULL GLOBAL BAKE (S3 Enabled)")
        print("⚠️  This will process ~3,486 TIFs and may take several hours.")
        S3_ENABLED = True
    else:
        print(f"🧪 RUNNING MINI-BAKE ({grid_size}×{grid_size} grid, S3 Disabled)")
        S3_ENABLED = False

    # --- CLEANUP (Non-destructive) ---
    dirs_to_ensure = ["frontend/app/tiles_bin", "frontend/app/aerial_tiles", 
                      "frontend/app/aerial_tiles/full", "frontend/app/aerial_tiles/low"]
    for d in dirs_to_ensure:
        os.makedirs(d, exist_ok=True)

    # --- OPEN DEM (not read into memory — windowed reads per sector) ---
    print("Opening DEM...")
    dem = rasterio.open(DEM_PATH)
    dem_poly = box(*dem.bounds)
    print(f"✅ DEM: {dem.width}×{dem.height}, bounds: {dem.bounds}")

    upsample = 2
    # Gradient map: deferred until we know the bake region (mini-bake generates a small one)
    grad_ds = None

    valid_tifs = []

    # Calculate Bounds
    if args.full:
        print("Scanning ALL TIFs...")
        for f in glob.glob(os.path.join(AERIAL_DIR, "*.tif")):
            try:
                with rasterio.open(f) as src: valid_tifs.append({"path": f, "poly": box(*src.bounds)})
            except: pass
        
        all_min_x, all_min_y = 1e12, 1e12
        all_max_x, all_max_y = -1e12, -1e12
        for t in valid_tifs:
            b = t["poly"].bounds
            all_min_x, all_min_y = min(all_min_x, b[0]), min(all_min_y, b[1])
            all_max_x, all_max_y = max(all_max_x, b[2]), max(all_max_y, b[3])
        
        min_sx, min_sy = coord_util.world_to_sector_id(all_min_x, all_min_y)
        max_sx, max_sy = coord_util.world_to_sector_id(all_max_x, all_max_y)
    else:
        # Mini-Bake Range
        if args.center:
            try:
                csx, csy = map(int, args.center.split(","))
                print(f"📍 Using custom center sector: ({csx}, {csy})")
            except:
                print(f"⚠️  Invalid center format '{args.center}'. Expected 'Q,R'. Falling back to Stubai.")
                cx, cy = latlon_to_world_meters(STUBAI_LAT, STUBAI_LON)
                csx, csy = coord_util.world_to_sector_id(cx, cy)
        else:
            cx, cy = latlon_to_world_meters(STUBAI_LAT, STUBAI_LON)
            csx, csy = coord_util.world_to_sector_id(cx, cy)
            print(f"📍 Using default Stubai center: ({csx}, {csy})")

        half = grid_size // 2
        min_sx, max_sx = csx - half, csx + half - 1
        min_sy, max_sy = csy - half, csy + half - 1
        
        # Proper Bounding Box for the entire Mini-Bake Area
        m_x1, m_y1, _, _ = coord_util.sector_id_to_bounds_meters(min_sx, min_sy)
        _, _, m_x2, m_y2 = coord_util.sector_id_to_bounds_meters(max_sx, max_sy)
        mini_box = box(m_x1, m_y1, m_x2, m_y2)

        # Only load intersecting TIFs
        print("Filtering TIFs for Mini-Bake area...")
        tif_list = glob.glob(os.path.join(AERIAL_DIR, "*.tif"))
        for f in tif_list:
            try:
                with rasterio.open(f) as src:
                    t_poly = box(*src.bounds)
                    if t_poly.intersects(mini_box):
                        valid_tifs.append({"path": f, "poly": t_poly})
            except: pass
        print(f"✅ Found {len(valid_tifs)} intersecting TIFs (of {len(tif_list)} total).")

        # Generate a lightweight regional gradient (~150MB vs 14GB full cache)
        grad_ds = generate_regional_gradient(
            dem, (m_x1, m_y1, m_x2, m_y2), upsample_factor=upsample)

    # For full bake, use the pre-computed full gradient cache
    if grad_ds is None:
        grad_ds = get_or_create_gradient_map(DEM_PATH, GRADIENT_PATH, upsample_factor=upsample)

    total_sectors = (max_sx - min_sx + 1) * (max_sy - min_sy + 1)
    print(f"Sector Range: SX[{min_sx}..{max_sx}], SY[{min_sy}..{max_sy}] ({total_sectors} sectors)")

    bake_times = []
    skipped = 0
    skipped_no_dem = 0
    skipped_no_imagery = 0
    total_bake_start = time.time()

    for sx in range(min_sx, max_sx + 1):
        for sy in range(min_sy, max_sy + 1):
            sector_box = box(*coord_util.sector_id_to_bounds_meters(sx, sy))
            if not dem_poly.intersects(sector_box):
                skipped_no_dem += 1
                continue
            has_imagery = any(t["poly"].intersects(sector_box) for t in valid_tifs)
            if not has_imagery:
                skipped_no_imagery += 1
                continue
            # Skip logic (already baked)
            bin_file = f"frontend/app/tiles_bin/sector_{sx}_{sy}.bin"
            tex_file = f"frontend/app/aerial_tiles/full/sector_{sx}_{sy}.webp"
            if can_skip and os.path.exists(bin_file) and os.path.exists(tex_file):
                skipped += 1
                continue

            t0 = time.time()
            print(f"Cooking Sector {sx}, {sy}...")
            bake_sector_textures(sx, sy, valid_tifs)
            bake_sector_binary(sx, sy, dem, grad_ds)
            elapsed = time.time() - t0
            bake_times.append(elapsed)
            print(f"   ⏱️  {elapsed:.1f}s")
            gc.collect()

    total_elapsed = time.time() - total_bake_start
    skip_parts = []
    if skipped: skip_parts.append(f"{skipped} cached")
    if skipped_no_dem: skip_parts.append(f"{skipped_no_dem} no-DEM")
    if skipped_no_imagery: skip_parts.append(f"{skipped_no_imagery} no-imagery")
    skip_summary = f"  ⏭️  Skipped: {', '.join(skip_parts)}" if skip_parts else ""
    if bake_times:
        avg = sum(bake_times) / len(bake_times)
        print(f"\n📊 Bake Stats: {len(bake_times)} sectors in {total_elapsed:.1f}s "
              f"(avg {avg:.1f}s/sector){skip_summary}")
    elif skip_parts:
        print(f"\n⏩ Nothing to bake.{skip_summary}")

    dem.close()

    # Update metadata
    with open(METADATA_PATH, "w") as f:
        json.dump({"baker_version": BAKER_VERSION, "last_bake": time.ctime(),
                   "grid_size": grid_size, "sectors_baked": len(bake_times)}, f)

    generate_manifest.generate_manifest()
    # Upload manifest last
    manifest_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../frontend/app/tile_manifest.json"))
    upload_to_s3(manifest_path)
    print("Done.")

if __name__ == "__main__": main()
