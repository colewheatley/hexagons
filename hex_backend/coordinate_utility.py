import math
import numpy as np

# =============================================================================
# PIXEL-FIRST CONSTANTS (UNIT-BASED)
# =============================================================================
UNIT_HEX_PX = 32.0           # Exactly 32 pixels flat-to-flat
METERS_PER_PIXEL = 0.2       # The "Tirol Truth"

# Scale Factors (Visual / LOD)
UNIT_HEX_WIDTH_METERS = UNIT_HEX_PX * METERS_PER_PIXEL  # 6.4 meters exactly

# SECTOR DEFINITION (Rectangular Bins)
# User mentioned expecting 1024x1024.
# If we want the "High Res" (1/4 scale) to be exactly 1024px:
# 1024 * 4 = 4096 pixels for Full Res.
# 4096 pixels * 0.2 m/pixel = 819.2 meters.
SECTOR_SIZE_METERS = 819.2 
SECTOR_PIXELS = 4096 # 819.2 / 0.2

# Directions (Source of Truth: Flat Top, North Start, Clockwise)
NORTH = 0      # +r (Axial 0, 1)
NORTH_EAST = 1 # (Axial 1, 0)
SOUTH_EAST = 2 # (Axial 1, -1)
SOUTH = 3      # (Axial 0, -1)
SOUTH_WEST = 4 # (Axial -1, 0)
NORTH_WEST = 5 # (Axial -1, 1)

def get_hex_dimensions():
    """
    Returns the calculated dimensions of the hexes based on pixel constants.
    """
    return {
        'sector_width_m': SECTOR_SIZE_METERS,
        'unit_hex_width_m': UNIT_HEX_WIDTH_METERS,
        'unit_hex_radius_m': UNIT_HEX_WIDTH_METERS / math.sqrt(3),
        'pixels_per_unit_hex': UNIT_HEX_PX,
        'texture_size_px': SECTOR_PIXELS
    }

def axial_to_world_meters(q, r):
    """
    Converts Universal Unit Axial (q, r) to World Meters (x, y).
    Standard Flat Top Orientation:
    - q axis points ~East/South-East
    - r axis points North
    """
    h = UNIT_HEX_WIDTH_METERS
    world_x = (q * (math.sqrt(3)/2) * h)
    world_y = (r * h + q * 0.5 * h)
    return world_x, world_y
    
def world_meters_to_axial_approx(x, y):
    """
    Finds the nearest q,r for a given x,y.
    """
    h = UNIT_HEX_WIDTH_METERS
    A = (math.sqrt(3)/2 * h)
    q = x / A
    r = (y - (q * 0.5 * h)) / h
    return q, r 

def world_meters_to_axial_scale(x, y, s):
    """
    Finds the nearest q,r for a given x,y at Scale s.
    """
    eff_h = UNIT_HEX_WIDTH_METERS * s
    A = (math.sqrt(3)/2 * eff_h)
    q = x / A
    r = (y - (q * 0.5 * eff_h)) / eff_h
    return q, r 

def round_axial(q, r):
    x_cube = q
    z_cube = r
    y_cube = -q - r
    rx, ry, rz = round(x_cube), round(y_cube), round(z_cube)
    x_diff, y_diff, z_diff = abs(rx - x_cube), abs(ry - y_cube), abs(rz - z_cube)
    if x_diff > y_diff and x_diff > z_diff: rx = -ry - rz
    elif y_diff > z_diff: ry = -rx - rz
    else: rz = -rx - ry
    return int(rx), int(rz)

def world_to_sector_id(x, y):
    sx = math.floor(x / SECTOR_SIZE_METERS)
    sy = math.floor(y / SECTOR_SIZE_METERS)
    return sx, sy

def sector_id_to_bounds_meters(sx, sy):
    min_x = sx * SECTOR_SIZE_METERS
    min_y = sy * SECTOR_SIZE_METERS
    max_x = min_x + SECTOR_SIZE_METERS
    max_y = min_y + SECTOR_SIZE_METERS
    return min_x, min_y, max_x, max_y

def get_sector_center(sx, sy):
    min_x, min_y, max_x, max_y = sector_id_to_bounds_meters(sx, sy)
    return (min_x + max_x) * 0.5, (min_y + max_y) * 0.5

def get_hexes_in_bbox(min_x, max_x, min_y, max_y, padding_m=0.0):
    min_x -= padding_m
    max_x += padding_m
    min_y -= padding_m
    max_y += padding_m
    corners = [(min_x, min_y), (max_x, min_y), (max_x, max_y), (min_x, max_y)]
    qs, rs = [], []
    for cx, cy in corners:
        fq, fr = world_meters_to_axial_approx(cx, cy)
        qs.append(fq); rs.append(fr)
    for q in range(int(min(qs)) - 2, int(max(qs)) + 2):
        for r in range(int(min(rs)) - 2, int(max(rs)) + 2):
            wx, wy = axial_to_world_meters(q, r)
            if min_x <= wx <= max_x and min_y <= wy <= max_y: yield (q, r)

def get_lod_grid_hexes_in_bbox(min_x, max_x, min_y, max_y, scale_factor, padding_m=0.0):
    eff_h = UNIT_HEX_WIDTH_METERS * scale_factor
    A = (math.sqrt(3)/2 * eff_h)
    
    # STRICT BOUNDS: Do not use padding for Center Containment.
    # Otherwise neighboring sectors generate the same hex multiple times (overlap).
    # padding_m parameter is kept for signature compatibility but ignored for clipping.
    
    def to_prime(x, y):
         q = x / A
         r = (y - (q * 0.5 * eff_h)) / eff_h
         return q, r
    corners = [(min_x, min_y), (max_x, min_y), (max_x, max_y), (min_x, max_y)]
    qs, rs = [], []
    for cx, cy in corners:
        q, r = to_prime(cx, cy)
        qs.append(q); rs.append(r)
    found = []
    
    # Iterate a slightly wider integer range to catch edges, but strict clip on centers
    for q in range(int(min(qs)) - 2, int(max(qs)) + 2):
        for r in range(int(min(rs)) - 2, int(max(rs)) + 2):
            wx = q * dx_dq_scaled(scale_factor)
            wy = r * dy_dr_scaled(scale_factor) + q * dy_dq_scaled(scale_factor)
            
            # STRICT Check against Sector Bounds
            # Use < max to ensure exclusive upper bound (prevent double ownership at exact boundary)
            if min_x <= wx < max_x and min_y <= wy < max_y:
                found.append((q, r, wx, wy))
    return found

def dx_dq_scaled(s): return (math.sqrt(3)/2) * (UNIT_HEX_WIDTH_METERS * s)
def dy_dq_scaled(s): return 0.5 * (UNIT_HEX_WIDTH_METERS * s)
def dy_dr_scaled(s): return UNIT_HEX_WIDTH_METERS * s
