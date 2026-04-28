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
