import json
import os

TIFF_DIR = '../aerial_tifs'
GRID_STATUS = '../grid_status.json'
QUEUE_FILE = '../download_queue.json'

def get_grid_bounds(grid_id):
    try:
        prefix, suffix = grid_id.split('-')
        xx, yy = int(prefix[:2]), int(prefix[2:])
        ss = int(suffix)
        base_x = (xx - 16) * 10000
        base_y = (yy - 1) * 10000 + 2000
        s_idx = ss - 1 if ss > 0 else 0
        col, row = s_idx % 8, s_idx // 8
        left = base_x + col * 1250
        right = left + 1250
        top = base_y + 8000 - (row * 1000)
        bottom = top - 1000
        return (left, bottom, right, top)
    except: return None

def is_in_box(gid, min_x, max_x, min_y, max_y):
    b = get_grid_bounds(gid)
    if not b: return False
    # Check if tile overlaps or is contained. 
    # For simplicity, we check if the center of the tile is inside the box.
    cx = (b[0] + b[2]) / 2
    cy = (b[1] + b[3]) / 2
    return min_x <= cx <= max_x and min_y <= cy <= max_y

def main():
    # Load all available tiles from multiple scans
    # Our grid_status.json currently only holds the LATEST scan.
    # We should probably compile a master list of all worldfiles on disk.
    available_gids = set()
    wf_dir = './worldfiles_for_aerials'
    if os.path.exists(wf_dir):
        for f in os.listdir(wf_dir):
            if f.endswith('.tfw'):
                parts = f.split('_')
                if len(parts) >= 2:
                    available_gids.add(parts[1])

    # Define our target boxes
    boxes = []
    
    # Box 1: Southern / Central Area (Refined)
    b1_w = get_grid_bounds('2123-44')
    b1_e = get_grid_bounds('2323-47')
    b1_s = get_grid_bounds('2121-76')
    if b1_w and b1_e and b1_s:
        boxes.append({
            'name': 'Southern / Central',
            'min_x': b1_w[0], 'max_x': b1_e[2],
            'min_y': b1_s[1], 'max_y': min(b1_w[3], b1_e[3])
        })

    # Box 2: Ischgl / Silvretta
    b2_ll = get_grid_bounds('1421-56')
    b2_lr = get_grid_bounds('1621-50')
    b2_ur = get_grid_bounds('1624-66')
    if b2_ll and b2_lr and b2_ur:
        boxes.append({
            'name': 'Ischgl / Silvretta',
            'min_x': b2_ll[0], 'max_x': b2_lr[2],
            'min_y': b2_ll[1], 'max_y': b2_ur[3]
        })

    # Box 3: St. Anton / Arlberg (The "everything in between" one)
    b3_lr = get_grid_bounds('2223-49')
    b3_ul = get_grid_bounds('2024-13')
    if b3_lr and b3_ul:
        boxes.append({
            'name': 'Arlberg / In-Between',
            'min_x': b3_ul[0], 'max_x': b3_lr[2],
            'min_y': b3_lr[1], 'max_y': b3_ul[3]
        })

    final_queue = set()
    print("Evaluating boxes...")
    for box in boxes:
        count = 0
        for gid in available_gids:
            if is_in_box(gid, box['min_x'], box['max_x'], box['min_y'], box['max_y']):
                final_queue.add(gid)
                count += 1
        print(f" - {box['name']}: Found {count} available tiles.")

    # Remove what is already on disk
    on_disk = set()
    if os.path.exists(TIFF_DIR):
        for f in os.listdir(TIFF_DIR):
            if f.endswith('.tif'):
                parts = f.split('_')
                if len(parts) >= 2:
                    on_disk.add(parts[1])

    queue_list = sorted(list(final_queue - on_disk))
    
    with open(QUEUE_FILE, 'w') as f:
        json.dump({'queue': queue_list}, f, indent=2)

    print(f"\nTotal merged queue size: {len(queue_list)}")
    print(f"Already on disk: {len(on_disk)}")
    print(f"Total tiles accounted for: {len(final_queue)}")

if __name__ == "__main__":
    main()
