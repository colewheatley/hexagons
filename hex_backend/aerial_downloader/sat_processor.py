import os
import glob
import rasterio
from PIL import Image
import concurrent.futures

# --- CONFIG ---
SOURCE_DIR = "/Users/cole/dev/PowFinder/hex_backend/aerial_tifs"
OUTPUT_DIR = "/Users/cole/dev/PowFinder/frontend/hexagons/app/tiles_sat"
QUALITY = 10

def process_tif(tif_path):
    try:
        with rasterio.open(tif_path) as src:
            # Get Easting/Northing from Top-Left origin
            bounds = src.bounds
            easting = int(bounds.left)
            northing = int(bounds.top)
            
        out_name = f"tile_{easting}_{northing}.webp"
        out_path = os.path.join(OUTPUT_DIR, out_name)
        
        # Open and save as WebP
        img = Image.open(tif_path)
        img.save(out_path, "WEBP", quality=QUALITY)
        return f"SUCCESS: {tif_path} -> {out_name}"
    except Exception as e:
        return f"ERROR ({tif_path}): {str(e)}"

def main():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        
    tifs = glob.glob(os.path.join(SOURCE_DIR, "*.tif"))
    print(f"Found {len(tifs)} TIFs. Starting conversion to WebP (Quality: {QUALITY})...")
    
    # Process in parallel to save time
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(process_tif, tifs))
        
    for res in results:
        print(res)

if __name__ == "__main__":
    main()
