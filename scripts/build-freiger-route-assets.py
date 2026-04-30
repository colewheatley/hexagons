import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

import rasterio
from pyproj import Transformer


ROOT = Path(__file__).resolve().parents[1]
KML_PATH = ROOT / "freiger_ascent.kml"
DEM_PATH = ROOT / "hex_backend" / "DGM_Tirol_5m_epsg31254_2006_2020.tif"
OUT_GLOBAL = ROOT / "frontend" / "app" / "assets" / "freiger_route_3d.json"
OUT_SECTORS = ROOT / "frontend" / "app" / "assets" / "freiger_route_sectors"

SECTOR_SIZE_METERS = 819.2
SAMPLE_SPACING_METERS = 3.0


def parse_kml_coordinates(path):
    ns = {"kml": "http://www.opengis.net/kml/2.2"}
    root = ET.parse(path).getroot()
    coords = []
    for node in root.findall(".//kml:LineString/kml:coordinates", ns):
        for chunk in (node.text or "").split():
            parts = chunk.split(",")
            if len(parts) < 2:
                continue
            lon = float(parts[0])
            lat = float(parts[1])
            alt = float(parts[2]) if len(parts) > 2 else 0.0
            coords.append((lon, lat, alt))
    return coords


def densify(points, spacing):
    dense = []
    for i, point in enumerate(points):
        if i == 0:
            dense.append(point)
            continue
        prev = points[i - 1]
        dx = point[0] - prev[0]
        dy = point[1] - prev[1]
        dist = math.hypot(dx, dy)
        steps = max(1, math.ceil(dist / spacing))
        for step in range(1, steps + 1):
            t = step / steps
            dense.append((
                prev[0] + dx * t,
                prev[1] + dy * t,
            ))
    return dense


def sector_id(x, y):
    return math.floor(x / SECTOR_SIZE_METERS), math.floor(y / SECTOR_SIZE_METERS)


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")


def main():
    lon_lat = parse_kml_coordinates(KML_PATH)
    if len(lon_lat) < 2:
        raise SystemExit(f"No route coordinates found in {KML_PATH}")

    transformer = Transformer.from_crs("EPSG:4326", "EPSG:31254", always_xy=True)
    projected = [transformer.transform(lon, lat) for lon, lat, _alt in lon_lat]
    dense_xy = densify(projected, SAMPLE_SPACING_METERS)

    with rasterio.open(DEM_PATH) as dem:
        samples = list(dem.sample(dense_xy))
        nodata = dem.nodata

    points = []
    total = 0.0
    last_x = last_y = None
    last_elevation = None
    for idx, ((x, y), sample) in enumerate(zip(dense_xy, samples)):
        elevation = float(sample[0])
        if nodata is not None and elevation == nodata:
            elevation = last_elevation if last_elevation is not None else 0.0
        if last_x is not None:
            total += math.hypot(x - last_x, y - last_y)
        q, r = sector_id(x, y)
        points.append({
            "x": round(x, 3),
            "y": round(y, 3),
            "e": round(elevation, 2),
            "d": round(total, 2),
            "q": q,
            "r": r,
        })
        last_x, last_y, last_elevation = x, y, elevation

    if OUT_SECTORS.exists():
        for old in OUT_SECTORS.glob("sector_*.json"):
            old.unlink()

    sectors = {}
    for idx, point in enumerate(points):
        key = f"{point['q']}_{point['r']}"
        bucket = sectors.setdefault(key, [])
        if idx > 0 and (not bucket or bucket[-1] != points[idx - 1]):
            bucket.append(points[idx - 1])
        bucket.append(point)
        if idx < len(points) - 1 and (points[idx + 1]["q"], points[idx + 1]["r"]) != (point["q"], point["r"]):
            bucket.append(points[idx + 1])

    global_payload = {
        "source": KML_PATH.name,
        "crs": "EPSG:31254",
        "spacing_m": SAMPLE_SPACING_METERS,
        "distance_m": round(total, 2),
        "points": points,
        "sectors": sorted(sectors.keys()),
    }
    write_json(OUT_GLOBAL, global_payload)

    for key, sector_points in sectors.items():
        q, r = map(int, key.split("_"))
        payload = {
            "source": OUT_GLOBAL.name,
            "crs": "EPSG:31254",
            "sector": {"q": q, "r": r},
            "points": sector_points,
        }
        write_json(OUT_SECTORS / f"sector_{q}_{r}.json", payload)

    print(f"Wrote {len(points)} sampled route points to {OUT_GLOBAL}")
    print(f"Wrote {len(sectors)} sector route files to {OUT_SECTORS}")


if __name__ == "__main__":
    main()
