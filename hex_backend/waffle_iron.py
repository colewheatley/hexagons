# 🧇 Waffle Iron v4.0 - Uber-Skirt Edition
# - 16-Byte "Uber-Hex" Layout (Power-of-Two aligned)
# - Gapless "Partial Skirt" Topology (SE, S, SW ownership)
# - "Diamond" Area Sampling for faithful edge slopes
# - Baked-in Center Normals (Nx, Nz) for smooth Cap lighting
# - Int16 Vertical Deltas (Decimeter precision)

import os
import glob
import math
import time
import numpy as np
import rasterio
import rasterio.enums
import rasterio.windows
import gc
import re
from shapely.geometry import Polygon, box
from multiprocessing import Pool, cpu_count
import sys
import struct
import subprocess
from pyproj import Transformer

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import coordinate_utility as coord_util
import generate_manifest

def latlon_to_world_meters(lat, lon):
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:31254", always_xy=True)
    return transformer.transform(lon, lat)

# =============================================================================
# S3 CONFIGURATION
# =============================================================================
S3_ENABLED = True
S3_BUCKET = "wheatley.cloud"
S3_PREFIX = "powfinder/hexagons/app"

# =============================================================================
# CONSTANTS & CONFIGURATION
# =============================================================================
TEXTURE_PADDING_PX = 64  
WEB_P_QUALITY = 10
DEBUG_MODE = False
TARGET_LAT = 46.98705560886202
TARGET_LON = 11.115050838788871

# Kappl: 47.06689, 10.35909
TARGET_LAT = 47.06689
TARGET_LON = 10.35909

# Stubai (Commented Out)
# TARGET_LAT = 46.98705560886202
# TARGET_LON = 11.115050838788871

DEM_PATH = "hex_backend/DGM_Tirol_5m_epsg31254_2006_2020.tif"
GRADIENT_PATH = "hex_backend/DGM_Tirol_gradient_cached.tif" # New Graph Cache
AERIAL_DIR = "hex_backend/aerial_tifs"

def upload_to_s3(local_path):
    """
    Uploads a file to S3 immediately.
    Maps local 'frontend/hexagons/app/...' to S3 'powfinder/hexagons/app/...'
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

def bake_sector_textures(SX, SY, valid_tifs, output_dir="frontend/hexagons/app/aerial_tiles"):
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

def bake_sector_binary(SX, SY, dem_data, dem_transform, grad_ds, output_dir="frontend/hexagons/app/tiles_bin"):
    if not os.path.exists(output_dir): os.makedirs(output_dir)
    min_x, min_y, max_x, max_y = coord_util.sector_id_to_bounds_meters(SX, SY)

    scales = [{"id": 3, "s": 24.0}, {"id": 2, "s": 6.0}, {"id": 1, "s": 3.0}, {"id": 0, "s": 1.0}]
    layers_data, min_z, max_z = [], 9999, -9999
    
    center_wx, center_wy = coord_util.get_sector_center(SX, SY)
    cq, cr = [int(round(v)) for v in coord_util.world_meters_to_axial_approx(center_wx, center_wy)]

    # We need to manually cache gradient data for the sector to avoid 1000s of disk reads
    # Read entire sector gradient + padding
    padding = 100.0
    g_window = rasterio.windows.from_bounds(min_x-padding, min_y-padding, max_x+padding, max_y+padding, grad_ds.transform)
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
    print("🧇 Waffle Iron v4.0: Uber-Skirt + Normals")
    
    print("Loading DEM...")
    with rasterio.open(DEM_PATH) as dem:
        dem_data = dem.read(1)
        dem_transform = dem.transform 
        dem_poly = box(*dem.bounds)

    upsample = 2 if not DEBUG_MODE else 1
    # Cache now stores Gradient (dx, dy)
    grad_ds = get_or_create_gradient_map(DEM_PATH, GRADIENT_PATH, upsample_factor=upsample)

    valid_tifs = []
    for f in glob.glob(os.path.join(AERIAL_DIR, "*.tif")):
        try:
            with rasterio.open(f) as src: valid_tifs.append({"path": f, "poly": box(*src.bounds)})
        except: pass

    # Calculate Bounds from TIFs
    print(f"Scanning TIF bounds for {len(valid_tifs)} files...")
    all_min_x, all_min_y = 1e12, 1e12
    all_max_x, all_max_y = -1e12, -1e12

    for t in valid_tifs:
        b = t["poly"].bounds # (minx, miny, maxx, maxy)
        all_min_x = min(all_min_x, b[0])
        all_min_y = min(all_min_y, b[1])
        all_max_x = max(all_max_x, b[2])
        all_max_y = max(all_max_y, b[3])

    min_sx, min_sy = coord_util.world_to_sector_id(all_min_x, all_min_y)
    max_sx, max_sy = coord_util.world_to_sector_id(all_max_x, all_max_y)

    print(f"Global Sector Range: SX[{min_sx} to {max_sx}], SY[{min_sy} to {max_sy}]")

    for sx in range(min_sx, max_sx + 1):
        for sy in range(min_sy, max_sy + 1):
            sector_box = box(*coord_util.sector_id_to_bounds_meters(sx, sy))
            if dem_poly.intersects(sector_box):
                # Only cook if it actually overlaps with one of our imagery TIFs
                # (Prevents cooking empty green/black space if DEM is larger than imagery)
                has_imagery = any(t["poly"].intersects(sector_box) for t in valid_tifs)
                if has_imagery:
                    print(f"Cooking Sector {sx}, {sy}...")
                    bake_sector_textures(sx, sy, valid_tifs)
                    bake_sector_binary(sx, sy, dem_data, dem_transform, grad_ds)
                    gc.collect()

    generate_manifest.generate_manifest()
    # Upload manifest last
    manifest_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../frontend/hexagons/app/tile_manifest.json"))
    upload_to_s3(manifest_path)
    print("Done.")

if __name__ == "__main__": main()
