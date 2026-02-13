import os
import requests
import sys
import json
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from pyproj import Transformer
except ImportError:
    Transformer = None

def check_and_download_worldfile(grid_id, year="2023", output_dir="./worldfiles_for_aerials"):
    """
    Downloads a .tfw worldfile for a given grid ID and year.
    Returns status: "downloaded", "already_exists", or "not_found"
    """
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        
    filename = f"dop_{grid_id}_{year}.tfw"
    url = f"https://gis.tirol.gv.at/geo/dop/m28/{filename}"
    target_path = os.path.join(output_dir, filename)
    
    if os.path.exists(target_path):
        return "already_exists"
        
    try:
        response = requests.get(url, timeout=5)
        if response.status_code == 200:
            with open(target_path, 'wb') as f:
                f.write(response.content)
            return "downloaded"
        elif response.status_code == 404:
            return "not_found"
        else:
            return f"error_{response.status_code}"
    except Exception as e:
        return f"failed_{str(e)}"

def get_grid_bounds(grid_id):
    """
    Calculates the bounding box for a Tirol grid ID in EPSG:31254.
    Format: XXYY-SS
    Returns (left, bottom, right, top)
    Note: Tirol grid usually follow 8x8 (01-64) but we support up to 99.
    """
    try:
        prefix, suffix = grid_id.split("-")
        xx = int(prefix[:2])
        yy = int(prefix[2:])
        ss = int(suffix)
        
        # Grid index (assuming 1-indexed for standard 64 tiles, but user wants 0-99)
        # This part depend on how they actually map 0-99. 
        # Usually 01-64 is an 8x8 grid within a 10km block.
        # XXYY refers to a 10km x 10km block.
        # XX: Easting / 10000 + 16 (approx)
        # YY: Northing / 10000 + 1 (approx)
        
        base_x = (xx - 16) * 10000
        base_y = (yy - 1) * 10000 + 2000
        
        # Standard Tirol 1:5000 tiles (1250m x 1000m)
        # 01-08: Top row
        # 09-16: Second row
        # ...
        # 57-64: Bottom row
        
        s_idx = ss - 1 if ss > 0 else 0
        col = s_idx % 8
        row = s_idx // 8
        
        left = base_x + col * 1250
        right = left + 1250
        top = base_y + 8000 - (row * 1000)
        bottom = top - 1000
        
        return (left, bottom, right, top)
    except Exception as e:
        return None

def mgi_to_gps(x, y):
    """Converts EPSG:31254 (MGI Austrian GK Central) to EPSG:4326 (WGS84)"""
    if Transformer is None:
        return (None, None)
    transformer = Transformer.from_crs("EPSG:31254", "EPSG:4326", always_xy=True)
    lon, lat = transformer.transform(x, y)
    return lat, lon

def process_one(gid_yr):
    gid, yr = gid_yr
    status = check_and_download_worldfile(gid, year=yr)
    bounds = get_grid_bounds(gid)
    
    gps_info = ""
    if bounds and Transformer:
        lat, lon = mgi_to_gps(bounds[2], bounds[3])
        gps_info = f" | UR: {lat:.6f}, {lon:.6f}"
        
    return gid, yr, status, gps_info

def main():
    if len(sys.argv) < 2:
        print("Usage: python check_tirol_grid.py <range_or_ids>")
        print("Examples:")
        print("  python check_tirol_grid.py 2121-53 2121-54")
        print("  python check_tirol_grid.py full_scan 2121 2122 ...")
        sys.exit(1)

    ids_to_check = []
    if sys.argv[1] == "full_scan":
        prefixes = sys.argv[2:]
        for p in prefixes:
            for i in range(0, 100): # 00 to 99 as requested
                ids_to_check.append((f"{p}-{i:02d}", "2023"))
    else:
        for arg in sys.argv[1:]:
            if ":" in arg:
                gid, yr = arg.split(":")
                ids_to_check.append((gid, yr))
            else:
                ids_to_check.append((arg, "2023"))

    results = {
        "downloaded": [],
        "already_exists": [],
        "not_found": [],
        "errors": {}
    }

    print(f"Checking {len(ids_to_check)} worldfiles using parallel threads...")
    
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(process_one, item): item for item in ids_to_check}
        for future in as_completed(futures):
            gid, yr, status, gps_info = future.result()
            display_id = f"{gid} ({yr})"
            
            if status == "downloaded":
                results["downloaded"].append(display_id)
                print(f" [✓] {display_id}{gps_info}: Downloaded")
            elif status == "already_exists":
                results["already_exists"].append(display_id)
                # print(f" [-] {display_id}: Already exists")
            elif status == "not_found":
                results["not_found"].append(display_id)
            else:
                results["errors"][display_id] = status
                print(f" [!] {display_id}: {status}")

    # Summary report
    print("\n--- Summary ---")
    print(f"Total checked:  {len(ids_to_check)}")
    print(f"Downloaded:    {len(results['downloaded'])}")
    print(f"Already had:   {len(results['already_exists'])}")
    print(f"Not Available: {len(results['not_found'])}")
    
    with open("../grid_status.json", "w") as f:
        json.dump(results, f, indent=2)
    print("\nStatus saved to ../grid_status.json")

if __name__ == "__main__":
    main()
