import os
import requests
from concurrent.futures import ThreadPoolExecutor

WF_DIR = "./worldfiles_for_aerials"

def download_wf(grid_id, year):
    filename = f"dop_{grid_id}_{year}.tfw"
    url = f"https://gis.tirol.gv.at/geo/dop/m28/{filename}"
    target_path = os.path.join(WF_DIR, filename)
    if os.path.exists(target_path): return None
    try:
        response = requests.get(url, timeout=5)
        if response.status_code == 200:
            with open(target_path, 'wb') as f:
                f.write(response.content)
            return grid_id
    except: pass
    return None

def main():
    tasks = []
    # Scan 3000 series for years 2022 and 2023
    for xx in range(30, 40):
        for yy in range(21, 31):
            for ss in range(1, 65):
                tasks.append((f"{xx}{yy}-{ss:02d}", "2022"))
                tasks.append((f"{xx}{yy}-{ss:02d}", "2023"))

    print(f"Scanning {len(tasks)} 3000-series potential worldfiles...")
    with ThreadPoolExecutor(max_workers=20) as executor:
        results = [executor.submit(download_wf, t[0], t[1]) for t in tasks]
        downloaded = len([r.result() for r in results if r.result() is not None])

    print(f"Done. Downloaded {downloaded} 3000-series worldfiles.")

if __name__ == "__main__":
    main()
