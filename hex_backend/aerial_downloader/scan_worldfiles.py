import os
import requests
from concurrent.futures import ThreadPoolExecutor

# --- CONFIG ---
WF_DIR = "./worldfiles_for_aerials"
YEAR = "2023"

def download_wf(grid_id):
    filename = f"dop_{grid_id}_{YEAR}.tfw"
    url = f"https://gis.tirol.gv.at/geo/dop/m28/{filename}"
    target_path = os.path.join(WF_DIR, filename)
    
    if os.path.exists(target_path):
        return None # Skip
        
    try:
        # Short timeout to keep the scan moving
        response = requests.get(url, timeout=5)
        if response.status_code == 200:
            with open(target_path, 'wb') as f:
                f.write(response.content)
            return grid_id
    except:
        pass
    return None

def main():
    if not os.path.exists(WF_DIR):
        os.makedirs(WF_DIR)

    tasks = []
    # Scanning North Tirol Range (Matching Easting <= 120k)
    for xx in range(14, 28): 
        for yy in range(21, 31):
            prefix = f"{xx}{yy}"
            for ss in range(1, 65):
                tasks.append(f"{prefix}-{ss:02d}")

    print(f"Scanning {len(tasks)} potential worldfiles...")
    
    downloaded = 0
    # Higher worker count for worldfiles as they are tiny
    with ThreadPoolExecutor(max_workers=20) as executor:
        results = list(executor.map(download_wf, tasks))
        downloaded = len([r for r in results if r is not None])

    print(f"\nScan complete. Downloaded {downloaded} new worldfiles.")

if __name__ == "__main__":
    main()
