import os
import rasterio
import numpy as np

# --- CONFIG ---
DEM_PATH = "../../backend/terrains/DGM_Tirol_5m_epsg31254_2006_2020.tif"
TIF_DIR = "../aerial_tifs"
WF_DIR = "./worldfiles_for_aerials"

# Tirol Grid Bounds calculation
def get_tile_bounds(xx, yy, ss):
    base_x = (xx - 16) * 10000
    base_y = (yy - 1) * 10000 + 2000
    s_idx = ss - 1
    col = s_idx % 8
    row = s_idx // 8
    left = base_x + col * 1250
    right = left + 1250
    top = base_y + 8000 - (row * 1000)
    bottom = top - 1000
    return (left, bottom, right, top)

def main():
    if not os.path.exists(DEM_PATH):
        print(f"Error: DEM not found at {DEM_PATH}")
        return

    with rasterio.open(DEM_PATH) as dem:
        dem_bounds = dem.bounds
        dem_res = dem.res[0]
        nodata = dem.nodata
        print(f"DEM Bounds: {dem_bounds}")
        print(f"DEM Resolution: {dem_res}m")

        # Range of XX and YY to scan
        # XX 14 to 27 (27-16 * 10000 = 110k, + 10k block = 120k max)
        # YY 21 to 30
        
        total_potential = 0
        valid_dem = 0
        already_downloaded = 0
        has_worldfile = 0
        to_download_list = []
        
        print("Scanning grid with Easting <= 120,000 cutoff...")
        for xx in range(14, 28): 
            for yy in range(21, 31):
                for ss in range(1, 65):
                    left, bottom, right, top = get_tile_bounds(xx, yy, ss)
                    
                    # Cutoff check
                    if right > 120000:
                        continue

                    # Check overlap with DEM extent
                    if (right < dem_bounds.left or left > dem_bounds.right or
                        bottom > dem_bounds.top or top < dem_bounds.bottom):
                        continue
                    
                    cx, cy = (left + right) / 2, (bottom + top) / 2
                    try:
                        row, col = dem.index(cx, cy)
                        window = rasterio.windows.Window(col, row, 1, 1)
                        data = dem.read(1, window=window)
                        if data.size > 0 and data[0,0] != nodata:
                            valid_dem += 1
                            grid_id = f"{xx}{yy}-{ss:02d}"
                            tif_name = f"dop_{grid_id}_2023.tif"
                            tfw_name = f"dop_{grid_id}_2023.tfw"
                            
                            if os.path.exists(os.path.join(TIF_DIR, tif_name)):
                                already_downloaded += 1
                            
                            if os.path.exists(os.path.join(WF_DIR, tfw_name)):
                                has_worldfile += 1
                                to_download_list.append(grid_id)
                    except:
                        continue

        to_download_list = []
        
        # Reset and re-scan for queue generation
        for xx in range(14, 37):
            for yy in range(21, 31):
                for ss in range(1, 65):
                    left, bottom, right, top = get_tile_bounds(xx, yy, ss)
                    if (right < dem_bounds.left or left > dem_bounds.right or
                        bottom > dem_bounds.top or top < dem_bounds.bottom):
                        continue
                    
                    cx, cy = (left + right) / 2, (bottom + top) / 2
                    try:
                        row, col = dem.index(cx, cy)
                        window = rasterio.windows.Window(col, row, 1, 1)
                        data = dem.read(1, window=window)
                        if data.size > 0 and data[0,0] != nodata:
                            grid_id = f"{xx}{yy}-{ss:02d}"
                            tif_name = f"dop_{grid_id}_2023.tif"
                            tfw_name = f"dop_{grid_id}_2023.tfw"
                            
                            # If we have a worldfile but no TIF, add to queue
                            if os.path.exists(os.path.join(WF_DIR, tfw_name)) and not os.path.exists(os.path.join(TIF_DIR, tif_name)):
                                to_download_list.append(grid_id)
                    except:
                        continue

        print("\n--- REPORT ---")
        print(f"Total potential tiles in XX[14-36] YY[21-30]: {total_potential}")
        print(f"Tiles with valid DEM data (North Tirol):     {valid_dem}")
        print(f"Tiles already downloaded:                    {already_downloaded}")
        print(f"Tiles with worldfiles (available):           {has_worldfile}")
        
        print(f"Queue size (Ready to download):              {len(to_download_list)}")
        
        import json
        with open("../download_queue.json", "w") as f:
            json.dump({"queue": to_download_list}, f, indent=2)
        print("Queue saved to ../download_queue.json")

        avg_size_mb = 9.5
        total_space_gb = (valid_dem * avg_size_mb) / 1024
        remaining_space_gb = (len(to_download_list) * avg_size_mb) / 1024
        
        print(f"\nEstimated total space for North Tirol: {total_space_gb:.2f} GB")
        print(f"Estimated remaining space needed:      {remaining_space_gb:.2f} GB")

if __name__ == "__main__":
    main()
