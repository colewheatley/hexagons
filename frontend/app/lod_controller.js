
// LOD Controller (Hybrid System + Benchmark)
// Implements three search strategies for comparison:
// 1. QuadTree: Standard spatial index (O(log N))
// 2. Linear Scan: Brute force iteration (O(N))
// 3. Grid Hash: Spatial hashing bucket system (O(1))

const SECTOR_WIDTH = 1000.0;
const UNIT_HEX_FLAT_TO_FLAT = SECTOR_WIDTH / Math.pow(7.0, 2.5); // ~7.7136m
const UNIT_HEX_RADIUS = UNIT_HEX_FLAT_TO_FLAT / Math.sqrt(3);

class QuadTree {
    constructor(bounds, capacity = 4) {
        this.bounds = bounds;
        this.capacity = capacity;
        this.points = [];
        this.divided = false;
        this.northeast = null;
        this.northwest = null;
        this.southeast = null;
        this.southwest = null;
    }

    subdivide() {
        const { x, y, width, height } = this.bounds;
        const w = width / 2;
        const h = height / 2;

        this.northeast = new QuadTree({ x: x + w / 2, y: y - h / 2, width: w, height: h }, this.capacity);
        this.northwest = new QuadTree({ x: x - w / 2, y: y - h / 2, width: w, height: h }, this.capacity);
        this.southeast = new QuadTree({ x: x + w / 2, y: y + h / 2, width: w, height: h }, this.capacity);
        this.southwest = new QuadTree({ x: x - w / 2, y: y + h / 2, width: w, height: h }, this.capacity);
        this.divided = true;
    }

    insert(point) {
        if (!this.contains(point)) return false;

        if (this.points.length < this.capacity) {
            this.points.push(point);
            return true;
        }

        if (!this.divided) this.subdivide();

        return (
            this.northeast.insert(point) ||
            this.northwest.insert(point) ||
            this.southeast.insert(point) ||
            this.southwest.insert(point)
        );
    }

    contains(point) {
        return (
            point.x >= this.bounds.x - this.bounds.width / 2 &&
            point.x <= this.bounds.x + this.bounds.width / 2 &&
            point.y >= this.bounds.y - this.bounds.height / 2 &&
            point.y <= this.bounds.y + this.bounds.height / 2
        );
    }

    queryRange(range, found = []) {
        if (!this.intersects(range)) return found;

        for (const p of this.points) {
            if (this.pointInRect(p, range)) found.push(p);
        }

        if (this.divided) {
            this.northwest.queryRange(range, found);
            this.northeast.queryRange(range, found);
            this.southwest.queryRange(range, found);
            this.southeast.queryRange(range, found);
        }
        return found;
    }

    intersects(range) {
        return !(
            range.x - range.width / 2 > this.bounds.x + this.bounds.width / 2 ||
            range.x + range.width / 2 < this.bounds.x - this.bounds.width / 2 ||
            range.y - range.height / 2 > this.bounds.y + this.bounds.height / 2 ||
            range.y + range.height / 2 < this.bounds.y - this.bounds.height / 2
        );
    }

    pointInRect(p, range) {
        return (
            p.x >= range.x - range.width / 2 &&
            p.x <= range.x + range.width / 2 &&
            p.y >= range.y - range.height / 2 &&
            p.y <= range.y + range.height / 2
        );
    }
}

class GridHash {
    constructor(cellSize) {
        this.cellSize = cellSize;
        this.buckets = new Map(); // Key: "gx,gy", Value: [Sector]
    }

    insert(sector) {
        const gx = Math.floor(sector.x / this.cellSize);
        const gy = Math.floor(sector.y / this.cellSize);
        const key = `${gx},${gy}`;
        if (!this.buckets.has(key)) this.buckets.set(key, []);
        this.buckets.get(key).push(sector);
    }

    query(range) {
        const results = [];
        // Determine grid bounds of the query range
        const minX = range.x - range.width / 2;
        const maxX = range.x + range.width / 2;
        const minY = range.y - range.height / 2;
        const maxY = range.y + range.height / 2;

        const minGx = Math.floor(minX / this.cellSize);
        const maxGx = Math.floor(maxX / this.cellSize);
        const minGy = Math.floor(minY / this.cellSize);
        const maxGy = Math.floor(maxY / this.cellSize);

        for (let gx = minGx; gx <= maxGx; gx++) {
            for (let gy = minGy; gy <= maxGy; gy++) {
                const key = `${gx},${gy}`;
                const bucket = this.buckets.get(key);
                if (bucket) {
                    for (const sec of bucket) {
                        // Fine-grained check still needed within buckets?
                        // Hash buckets are usually larger than range, or same size.
                        // We do the check to be precise.
                        const dx = Math.abs(sec.x - range.x);
                        const dy = Math.abs(sec.y - range.y);
                        if (dx <= range.width / 2 && dy <= range.height / 2) {
                            results.push(sec);
                        }
                    }
                }
            }
        }
        return results;
    }
}


export class LODController {
    constructor() {
        this.tree = null;
        this.grid = null;
        this.sectors = [];
        this.initialized = false;

        // Configuration
        this.nearThreshold = 200.0;  // Unit
        this.smallThreshold = 500.0; // Small
        this.medThreshold = 1000.0;  // Medium
        this.farThreshold = 2000.0;  // Large

        // This is now purely for the 'result' return, not the benchmark
        this.activeStrategy = 'HYBRID';
    }

    init(bounds, sectors) {
        const width = bounds.maxX - bounds.minX;
        const height = bounds.maxY - bounds.minY;
        const centerX = bounds.minX + width / 2;
        const centerY = bounds.minY + height / 2;

        // 1. Init Tree
        this.tree = new QuadTree({
            x: centerX, y: centerY, width, height
        });

        // 2. Init Grid
        this.grid = new GridHash(1000.0); // 1km Buckets

        this.sectors = sectors;

        sectors.forEach(sec => {
            this.tree.insert({ x: sec.x, y: sec.y, data: sec });
            this.grid.insert(sec);
        });

        this.initialized = true;
        console.log(`LODController: Benchmarks Ready. Tree & Grid Initialized.`);
    }

    setThresholds(levels) {
        if (levels.lod0 !== undefined) this.nearThreshold = levels.lod0;
        if (levels.lod1 !== undefined) this.smallThreshold = levels.lod1;
        if (levels.lod2 !== undefined) this.medThreshold = levels.lod2;
        if (levels.lod3 !== undefined) this.farThreshold = levels.lod3;
    }

    // Helper Math
    worldMetersToAxial(x, y) {
        const h = UNIT_HEX_FLAT_TO_FLAT;
        const q = x / ((Math.sqrt(3) / 2) * h);
        const r = (y - (q * 0.5 * h)) / h;
        return { q, r };
    }

    axialRound(q, r) {
        let x = q; let z = r; let y = -x - z;
        let rx = Math.round(x); let ry = Math.round(y); let rz = Math.round(z);
        const x_diff = Math.abs(rx - x);
        const y_diff = Math.abs(ry - y);
        const z_diff = Math.abs(rz - z);
        if (x_diff > y_diff && x_diff > z_diff) rx = -ry - rz;
        else if (y_diff > z_diff) ry = -rx - rz;
        else rz = -rx - ry;
        return { q: rx, r: rz };
    }

    // Main Benchmark Runner
    runBenchmark(cameraPos) {
        if (!this.initialized) return { times: { loop: 0, tree: 0, hash: 0 }, results: null };

        const range = {
            x: cameraPos.x,
            y: -cameraPos.z,
            width: this.farThreshold * 2,
            height: this.farThreshold * 2
        };

        const stats = {
            loop: 0,
            tree: 0,
            hash: 0
        };

        // 1. Linear Scan
        let t0 = performance.now();
        let loopCount = 0;
        for (const sec of this.sectors) {
            const dx = Math.abs(sec.x - range.x);
            const dy = Math.abs(sec.y - range.y);
            if (dx <= range.width / 2 && dy <= range.height / 2) loopCount++;
        }
        stats.loop = performance.now() - t0;

        // 2. QuadTree
        t0 = performance.now();
        const treeRes = this.tree.queryRange(range);
        stats.tree = performance.now() - t0;

        // 3. Grid Hash
        t0 = performance.now();
        const hashRes = this.grid.query(range);
        stats.hash = performance.now() - t0;

        // We return the Tree results for actual rendering, as it's the "safe" middle ground
        // (and Hash might have edge cases if I messed up bucket math)
        const finalSectors = treeRes.map(pt => pt.data || pt); // Tree returns points with data

        // Compute High Res (Fast Check)
        const highResults = [];
        const centerHex = this.worldMetersToAxial(cameraPos.x, -cameraPos.z);
        const centerInt = this.axialRound(centerHex.q, centerHex.r);
        const hexRadius = Math.ceil(this.nearThreshold / UNIT_HEX_FLAT_TO_FLAT);

        for (let dq = -hexRadius; dq <= hexRadius; dq++) {
            for (let dr = Math.max(-hexRadius, -dq - hexRadius); dr <= Math.min(hexRadius, -dq + hexRadius); dr++) {
                highResults.push({ q: centerInt.q + dq, r: centerInt.r + dr });
            }
        }

        return {
            times: stats,
            results: {
                high: highResults,
                low: finalSectors
            }
        };
    }

    // Legacy alias
    update(cameraPos) {
        return this.runBenchmark(cameraPos);
    }
}
