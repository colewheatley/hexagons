// @atlas: The 'CoordinateUtility' module. Provides essential math functions to convert between real-world cartesian meters and axial 'Hex' coordinates. It also handles dynamic EPSG:31254 projection calibration, using reference GPS data (e.g., from Kappl and St. Anton ski resorts) to maintain accurate metric scaling across the landscape.
const UNIT_HEX_PX = 32.0;
const METERS_PER_PIXEL = 0.2;
const UNIT_HEX_WIDTH_METERS = UNIT_HEX_PX * METERS_PER_PIXEL; // 6.4m
const SECTOR_WIDTH_METERS = 819.2; // 4096px

export function axialToWorldMeters(q, r) {
    const h = UNIT_HEX_WIDTH_METERS;
    const world_x = (q * (Math.sqrt(3) / 2) * h);
    const world_y = (r * h + q * 0.5 * h);
    return { x: world_x, y: world_y };
}

export function worldMetersToAxial(x, y) {
    const h = UNIT_HEX_WIDTH_METERS;
    const A = (Math.sqrt(3) / 2 * h);
    const q = x / A;
    const r = (y - (q * 0.5 * h)) / h;
    return { q: Math.round(q), r: Math.round(r) };
}

// Projection Calibration
let projParams = null;

export async function initProjection() {
    try {
        const res = await fetch('assets/skigebiete.json');
        const data = await res.json();
        const areas = data.ski_areas;

        // Use Kappl and St. Anton as baselines
        const p1 = areas.find(a => a.name === "Kappl");
        const p2 = areas.find(a => a.name === "St. Anton am Arlberg");

        if (p1 && p2) {
            const dLon = p2.gps.lon - p1.gps.lon;
            const dLat = p2.gps.lat - p1.gps.lat;
            const dX = p2.epsg_31254.x - p1.epsg_31254.x;
            const dY = p2.epsg_31254.y - p1.epsg_31254.y;

            // Linear Approximation (valid for local area)
            const scaleX = dX / dLon;
            const scaleY = dY / dLat;

            projParams = {
                scaleX, scaleY,
                refX: p1.epsg_31254.x,
                refY: p1.epsg_31254.y,
                refLon: p1.gps.lon,
                refLat: p1.gps.lat
            };
            console.log("Coordinate System Calibrated:", projParams);
        }
    } catch (e) {
        console.error("Failed to init projection", e);
    }
}

export function latLonToWorld(lat, lon) {
    if (!projParams) return { x: 0, y: 0 };
    const dx = (lon - projParams.refLon) * projParams.scaleX;
    const dy = (lat - projParams.refLat) * projParams.scaleY;
    return { x: projParams.refX + dx, y: projParams.refY + dy };
}
