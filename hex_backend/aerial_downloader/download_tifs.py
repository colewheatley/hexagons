import os
import requests
import sys

def download_tif(grid_id, year="2023", output_dir="../aerial_tifs"):
    """
    Downloads a TIF file for a given grid ID and year from the Tirol GIS server.
    Example URL: https://gis.tirol.gv.at/geo/dop/m28/dop_2121-53_2023.tif
    """
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        
    filename = f"dop_{grid_id}_{year}.tif"
    url = f"https://gis.tirol.gv.at/geo/dop/m28/{filename}"
    target_path = os.path.join(output_dir, filename)
    
    if os.path.exists(target_path):
        print(f"File already exists: {target_path}")
        return
        
    print(f"Downloading {url} ...")
    try:
        response = requests.get(url, stream=True)
        response.raise_for_status()
        
        with open(target_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        print(f"Successfully downloaded to {target_path}")
    except requests.exceptions.RequestException as e:
        print(f"Failed to download {grid_id}: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python download_tifs.py <grid_id1> <grid_id2> ...")
        print("Example: python download_tifs.py 2121-53 2121-54")
        sys.exit(1)
        
    ids = sys.argv[1:]
    for gid in ids:
        download_tif(gid)
