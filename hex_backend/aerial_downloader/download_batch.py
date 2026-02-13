import os
import json
import requests
import time

# --- ROBUST CONFIG ---
# We check these for existing files to avoid doubling up
SOURCE_CHECK_DIRS = [
    "../aerial_tifs",
    "./new unimplemented aerials"
]
# New downloads ALWAYS go here
TARGET_DIR = "./new unimplemented aerials"
WF_DIR = "./worldfiles_for_aerials"
QUEUE_FILE = "../download_queue.json"
YEAR = "2023"

def get_on_disk_gids():
    found = set()
    for d in SOURCE_CHECK_DIRS:
        if os.path.exists(d):
            files = [f for f in os.listdir(d) if f.endswith('.tif')]
            print(f"DEBUG: Found {len(files)} .tif files in {d}")
            for f in files:
                parts = f.split('_')
                if len(parts) >= 2:
                    found.add(parts[1])
    return found

def download_tif(grid_id):
    filename = f"dop_{grid_id}_{YEAR}.tif"
    url = f"https://gis.tirol.gv.at/geo/dop/m28/{filename}"
    target_path = os.path.join(TARGET_DIR, filename)
    
    # Worldfile MUST exist or the TIF is useless
    wf_name = f"dop_{grid_id}_{YEAR}.tfw"
    if not os.path.exists(os.path.join(WF_DIR, wf_name)):
        return grid_id, "skipped_no_worldfile"

    try:
        response = requests.get(url, stream=True, timeout=30)
        if response.status_code == 200:
            with open(target_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            return grid_id, "done"
        else:
            return grid_id, f"error_{response.status_code}"
    except Exception as e:
        return grid_id, f"failed_{str(e)}"

def main():
    if not os.path.exists(TARGET_DIR):
        os.makedirs(TARGET_DIR)

    if not os.path.exists(QUEUE_FILE):
        print(f"Error: Queue file not found at {QUEUE_FILE}")
        return

    with open(QUEUE_FILE, 'r') as f:
        data = json.load(f)
    
    raw_queue = data.get('queue', [])
    on_disk = get_on_disk_gids()
    
    # Filter queue: Must not be on disk AND must have a worldfile
    queue = []
    skipped_disk = 0
    skipped_wf = 0
    
    for gid in raw_queue:
        if gid in on_disk:
            skipped_disk += 1
            continue
        
        # We know worldfiles exist for everything in raw_queue 
        # because estimate_space.py already checked that.
        queue.append(gid)

    total = len(queue)
    print(f"--- PRE-FLIGHT CHECK ---")
    print(f"Initial Queue:      {len(raw_queue)}")
    print(f"Already on Disk:    {skipped_disk} (Checked {SOURCE_CHECK_DIRS})")
    print(f"Missing Worldfiles: {skipped_wf} (Skipped)")
    print(f"Final Target Queue: {total}")
    print(f"Destination:        {os.path.abspath(TARGET_DIR)}")
    print(f"------------------------\n")

    if total == 0:
        print("Nothing to download.")
        return

    # Check for disk space (rough check: 12MB per tile)
    estimated_mb = total * 12
    print(f"Estimated Space Needed: {estimated_mb/1024:.2f} GB")
    
    # Simple prompt for the user is handled by the agent, 
    # but we can do a small delay here if they want to cancel.
    time.sleep(1)

    for idx, gid in enumerate(queue):
        gid, status = download_tif(gid)
        count = idx + 1
        
        if status == "done":
            print(f"[{count}/{total}] ✓ {gid} saved to new folder")
            time.sleep(2) # Stay safe
        else:
            print(f"[{count}/{total}] ✗ {gid} : {status}")
            time.sleep(1)

    print("\nBatch download complete.")

if __name__ == "__main__":
    main()