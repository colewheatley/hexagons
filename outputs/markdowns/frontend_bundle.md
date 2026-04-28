# Hexagons — Code Bundle: frontend
#
# Generated : 2026-04-28 14:04 UTC
# Repo root : /Users/cole/dev/Hexagons
# Files     : 13 included
# Est tokens: ~63,093
#
# File list:
#   frontend/app/cache_manager.js
#   frontend/app/coordinate_utility.js
#   frontend/app/fuckups.md
#   frontend/app/index.html
#   frontend/app/lod_controller.js
#   frontend/app/main.js
#   frontend/app/search.js
#   frontend/app/style.css
#   frontend/app/tile_worker.js
#   frontend/app/vram_ledger.js
#   frontend/landing/gosper.html
#   frontend/landing/index.html
#   frontend/landing/radial.html
#
# ================================================================================


# ================================================================================
# FILE 1/13
# Path: frontend/app/cache_manager.js
# ================================================================================

// @atlas: Implements the 'Distance-Aware LRU' VRAM cache for the frontend. Prevents Out-Of-Memory crashes by enforcing a strict budget (default 5GB). Rather than simple batch eviction, it evaluates frustum visibility and anti-cycling distance margins (SWAP_MARGIN_METERS) to intelligently swap distant tiles for incoming tiles, providing buttery-smooth large-scale map traversals.
/**
 * CacheManager — LRU-Style Cache with Distance-Aware Swaps
 * 
 * The VRAM budget defines a hard tile capacity. Once full, the engine
 * ONLY loads a new tile if it is significantly more useful (closer) than
 * the worst tile currently held. This eliminates the eviction→redownload
 * cycle that plagued the previous batch-eviction approach.
 * 
 * Core invariant: a tile is never evicted unless either
 *   (a) it is outside the camera frustum, OR
 *   (b) the replacement tile is >= SWAP_MARGIN_METERS closer to the camera.
 */

import * as THREE from 'three';

// 5 GB — tight enough to force evictions during long traversals,
// generous enough to hold a useful vestigial pool (~100 tiles).
const DEFAULT_VRAM_BUDGET = 5 * 1024 * 1024 * 1024;

// Anti-cycling margin: a new tile must be at least this many meters closer
// than the eviction candidate. A sector is ~820 m wide, so 500 m means
// you must pan roughly half a sector before trailing tiles start getting
// swapped for leading-edge ones.
const SWAP_MARGIN_METERS = 500;

export class CacheManager {
    /**
     * @param {import('./vram_ledger.js').VRAMLedger} ledger
     * @param {number} [budget] - VRAM budget in bytes
     */
    constructor(ledger, budget = DEFAULT_VRAM_BUDGET) {
        this.ledger = ledger;
        this.budget = budget;

        // Lifetime stats
        this.evictionCount = 0;
        this.evictedBytes = 0;
        this.redownloadCount = 0;

        // Re-download detection — all tile keys ever evicted
        this.evictedHistory = new Set();

        // Per-turn stats (one "turn" = one processQueues() call)
        this._turn = { downloads: 0, evictions: 0, skips: 0, redownloads: 0 };
    }

    /** Current VRAM utilization as a 0–1 ratio */
    get utilization() {
        return this.ledger.totalVRAMBytes / this.budget;
    }

    /** Remaining VRAM headroom in bytes */
    get headroom() {
        return Math.max(0, this.budget - this.ledger.totalVRAMBytes);
    }

    /**
     * Check if a new allocation can fit within the budget.
     * @param {number} estimatedBytes - Estimated VRAM cost
     * @returns {boolean}
     */
    canAllocate(estimatedBytes) {
        return (this.ledger.totalVRAMBytes + estimatedBytes) <= this.budget;
    }

    // ─── Turn Tracking ────────────────────────────────────────────────

    /** Call at start of processQueues() */
    beginTurn() {
        this._turn = { downloads: 0, evictions: 0, skips: 0, redownloads: 0 };
    }

    /** Record that tile `key` is being downloaded */
    recordDownload(key) {
        this._turn.downloads++;
        if (this.evictedHistory.has(key)) {
            this._turn.redownloads++;
            this.redownloadCount++;
        }
    }

    /** Call at end of processQueues() — prints summary if anything happened */
    endTurn() {
        const s = this._turn;
        if (s.downloads === 0 && s.evictions === 0) return;

        let msg = `[CACHE] ↓${s.downloads} loaded`;
        if (s.evictions > 0) msg += `  ↑${s.evictions} swapped out`;
        if (s.skips > 0) msg += `  ⏸${s.skips} at-capacity`;
        if (s.redownloads > 0) msg += `  ⚠️ ${s.redownloads} RE-DOWNLOAD`;
        msg += `  | ${(this.ledger.totalVRAMBytes / 1048576).toFixed(0)} MB`;
        msg += ` / ${(this.budget / 1048576).toFixed(0)} MB`;
        msg += ` (${(this.utilization * 100).toFixed(0)}%)`;

        console.log(msg);
    }

    // ─── Core LRU Swap Logic ──────────────────────────────────────────

    /**
     * Find the least valuable loaded tile.
     * Out-of-frustum tiles get a +50 000 penalty to their score.
     *
     * @param {THREE.Vector3} cameraPosition
     * @param {THREE.Frustum} frustum
     * @param {Map} tilesMap
     * @param {string|null} excludeKey - don't consider this tile
     * @returns {{ key, score, dist, inFrustum, bytes }|null}
     */
    findLeastValuable(cameraPosition, frustum, tilesMap, excludeKey = null) {
        let worst = null;
        let worstScore = -Infinity;
        const _v = new THREE.Vector3();

        for (const [key, tile] of tilesMap) {
            if (key === excludeKey) continue;

            const entry = this.ledger.entries.get(key);
            if (!entry) continue;

            _v.set(entry.lx, 0, entry.lz);
            const dist = _v.distanceTo(cameraPosition);

            let inFrustum = true;
            if (tile.bounds && frustum) {
                inFrustum = frustum.intersectsBox(tile.bounds);
            }

            const score = dist + (inFrustum ? 0 : 50000);

            if (score > worstScore) {
                worstScore = score;
                worst = {
                    key, score, dist, inFrustum,
                    bytes: entry.geometryBytes + entry.textureBytes,
                };
            }
        }

        return worst;
    }

    /**
     * Try to swap the worst loaded tile for a new one.
     *
     * Rules:
     *   - Out-of-frustum tiles are always evictable (invisible anyway).
     *   - In-frustum tiles require the new tile to be SWAP_MARGIN_METERS
     *     closer to justify the bandwidth cost.
     *
     * @param {number} newTileDist - distance of the tile requesting load
     * @param {THREE.Vector3} cameraPosition
     * @param {THREE.Frustum} frustum
     * @param {Map} tilesMap
     * @param {function(string): void} unloadFn
     * @param {string|null} excludeKey - protect this tile from eviction
     * @returns {boolean} true if a tile was evicted
     */
    requestSwap(newTileDist, cameraPosition, frustum, tilesMap, unloadFn, excludeKey = null) {
        const worst = this.findLeastValuable(cameraPosition, frustum, tilesMap, excludeKey);
        if (!worst) return false;

        // Out-of-frustum ⇒ always evictable (they're invisible)
        if (worst.inFrustum) {
            // In-frustum: only swap if the new tile is SIGNIFICANTLY closer
            if (worst.dist <= newTileDist + SWAP_MARGIN_METERS) {
                this._turn.skips++;
                return false;
            }
        }

        // Execute the swap
        unloadFn(worst.key);
        this.evictionCount++;
        this.evictedBytes += worst.bytes;
        this.evictedHistory.add(worst.key);
        this._turn.evictions++;

        return true;
    }
}


# ================================================================================
# FILE 2/13
# Path: frontend/app/coordinate_utility.js
# ================================================================================

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


# ================================================================================
# FILE 3/13
# Path: frontend/app/fuckups.md
# ================================================================================

<!-- @atlas: Unfiltered engineering devlog and post-mortem tracker. Specifically captures raw console logs of historical rendering bottlenecks, such as the 'V3 Binary South-Push' matrix assignment latency when initializing 7,000+ hexes, serving as a historical record of architectural missteps and fixes. -->
--- NEW SESSION --- 8:50:56 PM
[LOG] Initializing PistonViewer...
[LOG] Starting init...
[LOG] Loading tile: 55000, 203000...
[LOG] Low-res texture applied.
[LOG] Fetching binary data...
[LOG] Medium-res texture upgraded.
[LOG] Binary data received: 205034 bytes.
[LOG] Parsing V3 Binary (South-Push + Slope)...
[LOG] Creating instanced mesh for 7070 hexes...
[LOG] Piston Range: -64352m to 64352m
[LOG] Piston Floor Offset: -64352m
[LOG] Starting Matrix Assignment Loop...
[LOG] Assigned matrices for 7070 instances.
[LOG] Max Local Height from Floor: 128704
[LOG] Camera Set: Pos [625, 19999.99999999, -500], Target [625, 0, -500]
[LOG] LoadTile complete, hiding loader.


# ================================================================================
# FILE 4/13
# Path: frontend/app/index.html
# ================================================================================

<!-- @atlas: The primary HTML5 shell for the PowFinder 'Bestagon' Viewer. Contains the full structure for the glassmorphic HUD overlay (performance telemetry, granular LOD tuning sliders, and frametime graphs) alongside the WebGL canvas container and the animated SVG loading screen. -->
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PowFinder | Bestagon Viewer</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="style.css">
    <script type="importmap">
        {
            "imports": {
                "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
                "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
            }
        }
    </script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/hammer.js/2.0.8/hammer.min.js"></script>
</head>

<body>
    <div id="loader">
        <div class="hex-pattern"></div>
        <div class="skier-container">
            <svg width="150" height="200" viewBox="0 0 1008 1356">
                <defs>
                    <linearGradient id="skierGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" style="stop-color:#ff6b9d;stop-opacity:1" />
                        <stop offset="100%" style="stop-color:#74b9ff;stop-opacity:1" />
                    </linearGradient>
                </defs>
                <path
                    d="M 927,116 L 925,116 L 920,113 L 918,113 L 915,111 L 912,111 L 906,108 L 902,108 L 898,106 L 890,105 L 889,104 L 885,103 L 884,104 L 880,105 L 876,109 L 876,112 L 874,114 L 874,117 L 873,119 L 869,123 L 867,123 L 866,122 L 860,122 L 859,121 L 851,121 L 850,120 L 846,120 L 845,119 L 838,119 L 837,118 L 831,118 L 830,117 L 824,117 L 823,116 L 815,116 L 814,115 L 810,115 L 809,114 L 793,113 L 789,111 L 780,111 L 779,110 L 772,110 L 771,109 L 768,109 L 767,108 L 758,108 L 757,107 L 745,106 L 744,105 L 736,105 L 735,104 L 731,104 L 730,103 L 722,103 L 721,102 L 716,102 L 715,101 L 710,101 L 709,100 L 699,100 L 698,99 L 695,99 L 694,98 L 688,98 L 687,97 L 678,97 L 677,96 L 672,96 L 671,95 L 666,95 L 665,94 L 657,94 L 656,93 L 651,93 L 650,92 L 641,92 L 640,91 L 637,91 L 636,90 L 620,89 L 619,88 L 616,88 L 615,87 L 598,86 L 597,85 L 594,85 L 593,84 L 585,84 L 584,83 L 578,83 L 577,82 L 571,82 L 570,81 L 563,81 L 562,80 L 557,80 L 556,79 L 542,78 L 541,77 L 537,77 L 536,76 L 526,76 L 525,75 L 520,75 L 519,74 L 515,74 L 514,73 L 504,73 L 503,72 L 499,72 L 498,71 L 493,71 L 492,70 L 484,70 L 483,69 L 481,69 L 478,66 L 478,63 L 473,53 L 469,50 L 466,50 L 462,52 L 460,54 L 456,62 L 453,65 L 435,65 L 433,66 L 436,67 L 438,69 L 441,69 L 445,72 L 447,72 L 449,74 L 450,74 L 452,76 L 453,82 L 456,88 L 459,91 L 463,93 L 468,91 L 475,84 L 476,81 L 480,78 L 481,79 L 485,79 L 486,80 L 494,80 L 495,81 L 501,81 L 502,82 L 507,82 L 508,83 L 516,83 L 517,84 L 521,84 L 522,85 L 529,85 L 530,86 L 536,86 L 537,87 L 542,87 L 543,88 L 552,88 L 553,89 L 557,89 L 558,90 L 572,91 L 573,92 L 577,92 L 578,93 L 595,94 L 599,96 L 609,96 L 610,97 L 620,98 L 621,99 L 630,99 L 631,100 L 634,100 L 635,101 L 651,102 L 655,104 L 664,104 L 665,105 L 671,105 L 672,106 L 678,106 L 679,107 L 686,107 L 687,108 L 699,109 L 700,110 L 707,110 L 708,111 L 713,111 L 714,112 L 728,113 L 729,114 L 734,114 L 735,115 L 742,115 L 743,116 L 748,116 L 749,117 L 763,118 L 764,119 L 769,119 L 770,120 L 778,120 L 779,121 L 784,121 L 785,122 L 790,122 L 791,123 L 801,123 L 805,125 L 821,126 L 822,127 L 825,127 L 826,128 L 842,129 L 843,130 L 846,130 L 847,131 L 853,131 L 855,133 L 851,137 L 850,137 L 847,140 L 845,140 L 844,141 L 842,141 L 838,143 L 830,143 L 829,144 L 826,144 L 825,145 L 818,146 L 816,148 L 814,148 L 812,150 L 806,153 L 795,162 L 794,162 L 786,170 L 785,170 L 784,172 L 783,172 L 774,180 L 771,181 L 769,183 L 767,183 L 762,186 L 760,186 L 758,188 L 754,189 L 752,191 L 750,191 L 739,197 L 737,197 L 735,199 L 729,202 L 727,202 L 724,204 L 716,205 L 715,206 L 710,206 L 709,207 L 698,207 L 686,213 L 676,213 L 675,214 L 671,214 L 670,215 L 664,215 L 660,217 L 657,217 L 656,216 L 656,209 L 657,208 L 657,197 L 658,196 L 658,177 L 657,176 L 657,172 L 656,171 L 655,165 L 653,162 L 652,157 L 650,155 L 649,152 L 647,150 L 645,146 L 642,143 L 642,142 L 635,135 L 634,135 L 630,132 L 628,132 L 624,130 L 620,130 L 619,129 L 615,129 L 614,128 L 609,128 L 608,127 L 593,127 L 592,126 L 587,126 L 586,127 L 572,127 L 571,128 L 568,128 L 567,129 L 562,129 L 561,130 L 557,130 L 554,132 L 551,132 L 547,135 L 541,138 L 541,139 L 539,140 L 535,144 L 534,146 L 533,146 L 533,147 L 529,152 L 528,155 L 526,157 L 522,165 L 522,167 L 520,170 L 519,175 L 517,178 L 516,185 L 514,189 L 514,194 L 513,195 L 513,198 L 512,199 L 512,204 L 511,205 L 511,207 L 506,211 L 506,215 L 505,216 L 506,230 L 503,233 L 497,234 L 495,236 L 491,237 L 488,240 L 487,240 L 481,245 L 480,245 L 445,276 L 441,277 L 438,279 L 436,279 L 435,280 L 431,280 L 427,282 L 418,283 L 414,285 L 408,285 L 407,286 L 405,286 L 401,288 L 396,288 L 394,290 L 391,290 L 385,293 L 382,293 L 377,296 L 375,296 L 373,298 L 366,301 L 363,304 L 362,304 L 359,307 L 358,307 L 335,331 L 334,331 L 327,336 L 325,336 L 320,339 L 317,339 L 314,341 L 309,342 L 306,344 L 302,345 L 300,347 L 298,347 L 292,352 L 291,352 L 291,353 L 283,360 L 279,362 L 254,362 L 253,363 L 241,363 L 237,365 L 227,366 L 223,368 L 215,369 L 214,370 L 208,371 L 207,372 L 205,372 L 201,374 L 198,374 L 195,376 L 192,376 L 191,377 L 188,377 L 185,379 L 181,379 L 179,380 L 178,379 L 178,375 L 180,372 L 180,369 L 183,364 L 183,362 L 185,359 L 185,357 L 188,351 L 188,348 L 190,344 L 190,339 L 187,337 L 185,337 L 182,339 L 180,339 L 176,343 L 175,346 L 173,348 L 168,358 L 168,360 L 166,362 L 164,362 L 159,358 L 152,358 L 149,364 L 150,376 L 152,380 L 150,383 L 143,383 L 140,380 L 140,371 L 139,370 L 139,361 L 138,360 L 138,349 L 137,348 L 138,347 L 138,338 L 139,337 L 139,334 L 140,333 L 140,328 L 142,324 L 142,319 L 143,318 L 143,311 L 144,310 L 144,305 L 143,304 L 143,300 L 142,298 L 140,296 L 137,296 L 133,299 L 133,300 L 125,309 L 124,312 L 122,314 L 122,316 L 119,322 L 119,326 L 117,329 L 117,336 L 116,337 L 116,341 L 115,342 L 115,350 L 114,351 L 114,369 L 113,370 L 113,385 L 109,388 L 105,388 L 104,389 L 102,389 L 101,390 L 97,390 L 96,391 L 94,391 L 90,393 L 86,393 L 83,395 L 79,395 L 76,397 L 72,398 L 68,401 L 68,404 L 70,406 L 78,410 L 80,410 L 83,412 L 77,418 L 76,422 L 74,425 L 74,430 L 76,434 L 77,440 L 80,446 L 83,449 L 83,450 L 86,451 L 88,453 L 91,453 L 92,454 L 95,454 L 96,455 L 112,455 L 113,454 L 118,454 L 119,453 L 124,453 L 128,451 L 132,451 L 135,456 L 135,459 L 136,460 L 136,463 L 138,467 L 138,471 L 139,472 L 139,474 L 141,478 L 141,482 L 143,486 L 144,493 L 146,496 L 147,504 L 149,507 L 149,511 L 151,515 L 152,523 L 154,526 L 155,534 L 157,537 L 157,541 L 158,542 L 158,544 L 160,548 L 160,552 L 162,555 L 163,563 L 164,564 L 165,570 L 167,574 L 168,582 L 170,585 L 170,589 L 171,590 L 171,592 L 173,596 L 173,600 L 174,601 L 174,603 L 176,607 L 176,611 L 177,612 L 178,618 L 179,619 L 179,622 L 181,626 L 181,630 L 184,636 L 184,641 L 185,642 L 185,644 L 187,648 L 187,651 L 189,655 L 189,659 L 190,660 L 190,662 L 192,666 L 192,670 L 194,674 L 195,681 L 197,684 L 197,688 L 198,689 L 198,692 L 199,693 L 200,699 L 202,703 L 203,711 L 205,714 L 206,722 L 207,723 L 208,729 L 209,730 L 210,736 L 211,737 L 211,741 L 213,744 L 214,751 L 216,755 L 216,759 L 217,760 L 217,762 L 219,766 L 219,770 L 220,771 L 221,777 L 222,778 L 222,780 L 224,784 L 224,788 L 225,789 L 225,791 L 227,795 L 227,799 L 228,800 L 229,806 L 230,807 L 230,813 L 231,814 L 231,819 L 232,820 L 232,832 L 233,833 L 233,839 L 234,840 L 234,848 L 235,849 L 235,859 L 236,860 L 236,868 L 237,869 L 237,876 L 238,877 L 238,887 L 239,888 L 239,891 L 240,892 L 240,904 L 241,905 L 241,911 L 242,912 L 242,920 L 243,921 L 243,931 L 244,932 L 244,937 L 245,938 L 246,958 L 247,959 L 247,963 L 248,964 L 248,976 L 249,977 L 249,983 L 250,984 L 250,990 L 251,991 L 251,1003 L 252,1004 L 252,1009 L 253,1010 L 253,1018 L 254,1019 L 254,1030 L 255,1031 L 255,1035 L 256,1036 L 256,1047 L 257,1048 L 257,1056 L 258,1057 L 258,1062 L 259,1063 L 259,1072 L 260,1073 L 260,1081 L 261,1082 L 261,1089 L 262,1090 L 262,1099 L 263,1100 L 263,1105 L 264,1106 L 264,1116 L 265,1117 L 265,1125 L 266,1126 L 266,1131 L 267,1132 L 267,1142 L 268,1143 L 268,1148 L 269,1149 L 269,1156 L 270,1157 L 270,1168 L 272,1172 L 273,1192 L 274,1193 L 274,1198 L 275,1199 L 275,1208 L 276,1209 L 276,1215 L 277,1216 L 277,1220 L 278,1221 L 278,1229 L 280,1232 L 281,1239 L 286,1249 L 286,1251 L 293,1261 L 294,1264 L 302,1273 L 302,1274 L 318,1290 L 322,1291 L 324,1293 L 333,1293 L 333,1290 L 328,1281 L 317,1269 L 314,1263 L 311,1260 L 306,1250 L 304,1248 L 304,1246 L 301,1241 L 301,1239 L 298,1234 L 298,1232 L 296,1229 L 295,1224 L 293,1221 L 293,1217 L 292,1216 L 292,1213 L 290,1209 L 290,1205 L 288,1201 L 287,1181 L 286,1180 L 286,1173 L 285,1172 L 285,1160 L 284,1159 L 284,1153 L 283,1152 L 283,1144 L 282,1143 L 282,1133 L 281,1132 L 281,1124 L 280,1123 L 280,1115 L 279,1114 L 279,1104 L 278,1103 L 278,1096 L 277,1095 L 277,1083 L 276,1082 L 275,1066 L 274,1065 L 274,1053 L 273,1052 L 273,1047 L 272,1046 L 272,1038 L 271,1037 L 271,1024 L 270,1023 L 270,1018 L 269,1017 L 269,1006 L 268,1005 L 267,989 L 266,988 L 266,976 L 265,975 L 264,961 L 263,960 L 263,948 L 262,947 L 262,943 L 261,942 L 261,937 L 263,935 L 264,936 L 264,940 L 266,943 L 266,946 L 267,947 L 267,952 L 268,953 L 268,956 L 269,957 L 269,960 L 270,961 L 270,967 L 272,971 L 273,982 L 275,985 L 275,991 L 276,992 L 276,996 L 278,1000 L 278,1006 L 280,1010 L 280,1015 L 281,1016 L 281,1020 L 283,1024 L 283,1030 L 284,1031 L 284,1035 L 286,1039 L 286,1045 L 288,1049 L 288,1054 L 289,1055 L 289,1059 L 290,1060 L 290,1063 L 291,1064 L 292,1073 L 293,1074 L 293,1077 L 294,1078 L 294,1083 L 296,1087 L 297,1098 L 299,1102 L 300,1112 L 302,1116 L 302,1122 L 304,1126 L 305,1137 L 307,1140 L 307,1145 L 308,1146 L 308,1150 L 309,1151 L 309,1154 L 310,1155 L 310,1161 L 312,1165 L 312,1169 L 313,1170 L 313,1174 L 314,1175 L 314,1178 L 315,1179 L 316,1188 L 318,1192 L 318,1198 L 319,1199 L 319,1202 L 320,1203 L 320,1206 L 321,1207 L 322,1216 L 323,1217 L 323,1220 L 324,1221 L 324,1226 L 326,1230 L 326,1235 L 327,1236 L 327,1238 L 329,1242 L 329,1245 L 331,1248 L 331,1250 L 334,1256 L 334,1258 L 336,1260 L 337,1264 L 339,1266 L 343,1274 L 349,1281 L 349,1282 L 353,1286 L 353,1287 L 362,1296 L 363,1296 L 366,1299 L 367,1299 L 372,1304 L 374,1304 L 377,1307 L 385,1308 L 386,1309 L 387,1308 L 389,1308 L 393,1306 L 394,1304 L 394,1298 L 392,1294 L 392,1291 L 390,1289 L 386,1280 L 384,1278 L 382,1274 L 379,1271 L 378,1268 L 374,1263 L 373,1260 L 371,1258 L 365,1246 L 365,1244 L 363,1242 L 363,1240 L 362,1239 L 362,1237 L 360,1235 L 360,1232 L 358,1229 L 357,1223 L 356,1222 L 355,1216 L 354,1215 L 354,1211 L 353,1210 L 353,1207 L 352,1206 L 351,1197 L 349,1193 L 349,1187 L 347,1183 L 346,1174 L 345,1173 L 345,1170 L 344,1169 L 344,1163 L 343,1162 L 342,1156 L 341,1155 L 341,1149 L 339,1145 L 338,1135 L 336,1131 L 336,1126 L 335,1125 L 335,1122 L 334,1121 L 334,1118 L 333,1117 L 333,1112 L 332,1111 L 332,1108 L 331,1107 L 330,1098 L 328,1094 L 327,1083 L 325,1079 L 325,1074 L 323,1070 L 323,1066 L 322,1065 L 322,1060 L 321,1059 L 321,1056 L 320,1055 L 319,1046 L 317,1042 L 317,1036 L 315,1032 L 314,1022 L 312,1018 L 312,1013 L 311,1012 L 311,1009 L 310,1008 L 309,998 L 308,997 L 308,994 L 307,993 L 306,984 L 304,980 L 303,970 L 301,966 L 301,960 L 300,959 L 300,957 L 299,956 L 299,952 L 298,951 L 298,947 L 300,945 L 302,947 L 308,947 L 311,942 L 311,932 L 309,930 L 309,928 L 301,913 L 301,911 L 298,906 L 298,904 L 295,899 L 295,897 L 293,894 L 292,889 L 290,886 L 290,883 L 288,879 L 288,870 L 291,868 L 293,868 L 301,872 L 305,872 L 306,873 L 310,873 L 316,870 L 319,867 L 320,864 L 322,862 L 322,860 L 323,859 L 323,857 L 325,853 L 325,836 L 328,830 L 335,823 L 336,823 L 340,820 L 347,820 L 348,821 L 351,821 L 353,823 L 358,824 L 361,826 L 364,826 L 367,828 L 370,828 L 371,829 L 377,829 L 378,830 L 383,830 L 384,831 L 398,831 L 399,832 L 417,832 L 418,833 L 425,833 L 426,834 L 437,834 L 438,835 L 442,835 L 446,837 L 451,837 L 452,838 L 458,839 L 459,840 L 465,840 L 469,842 L 475,842 L 476,843 L 481,843 L 482,844 L 487,844 L 488,845 L 497,845 L 498,846 L 503,846 L 504,847 L 514,847 L 515,848 L 539,848 L 540,847 L 544,847 L 548,845 L 552,845 L 557,842 L 559,842 L 566,837 L 568,837 L 570,835 L 578,831 L 580,829 L 586,826 L 592,821 L 596,819 L 607,809 L 607,808 L 612,802 L 612,800 L 615,794 L 615,788 L 616,787 L 616,781 L 617,780 L 617,778 L 618,776 L 622,772 L 622,771 L 624,769 L 625,769 L 626,766 L 629,762 L 629,760 L 630,759 L 630,749 L 631,748 L 631,742 L 630,741 L 630,725 L 629,724 L 629,709 L 628,708 L 628,696 L 627,695 L 627,691 L 626,690 L 626,684 L 625,683 L 625,680 L 623,676 L 623,673 L 621,670 L 620,664 L 618,661 L 618,659 L 617,658 L 615,650 L 613,647 L 612,642 L 609,636 L 609,633 L 608,632 L 608,627 L 609,626 L 609,619 L 610,618 L 610,614 L 612,611 L 612,607 L 614,603 L 615,595 L 617,592 L 617,588 L 618,587 L 618,582 L 619,581 L 619,579 L 625,568 L 634,558 L 634,557 L 638,552 L 639,549 L 641,547 L 645,539 L 645,537 L 647,535 L 647,532 L 650,527 L 650,524 L 652,521 L 652,518 L 655,512 L 655,507 L 656,506 L 656,504 L 658,500 L 658,495 L 659,494 L 659,491 L 660,490 L 660,487 L 661,486 L 661,480 L 663,476 L 671,466 L 671,464 L 674,460 L 674,458 L 677,453 L 677,450 L 679,448 L 680,442 L 682,439 L 682,433 L 683,432 L 683,430 L 684,429 L 684,425 L 685,424 L 685,417 L 687,413 L 687,387 L 686,386 L 686,382 L 685,381 L 685,374 L 684,373 L 684,367 L 683,366 L 683,361 L 682,360 L 682,344 L 683,343 L 683,340 L 685,336 L 695,327 L 697,327 L 699,325 L 705,322 L 707,322 L 712,319 L 716,319 L 721,316 L 725,316 L 728,314 L 734,313 L 744,308 L 746,308 L 758,302 L 760,300 L 762,300 L 768,295 L 769,295 L 771,293 L 778,289 L 783,284 L 784,284 L 787,281 L 788,281 L 799,270 L 800,270 L 800,269 L 827,241 L 827,240 L 838,228 L 838,227 L 861,204 L 862,204 L 865,201 L 866,201 L 869,198 L 870,198 L 878,190 L 879,190 L 885,184 L 886,184 L 891,179 L 892,179 L 893,177 L 894,177 L 902,170 L 903,170 L 908,166 L 910,166 L 914,164 L 920,164 L 921,163 L 923,163 L 925,161 L 928,160 L 928,159 L 930,157 L 931,157 L 936,153 L 941,152 L 943,150 L 944,150 L 948,145 L 948,139 L 947,138 L 947,136 L 945,132 L 942,129 L 942,128 L 939,125 L 939,124 L 938,124 L 935,121 L 929,118 Z M 185,486 L 187,487 L 192,492 L 194,496 L 201,503 L 203,507 L 204,507 L 205,509 L 210,514 L 210,515 L 214,519 L 214,520 L 218,524 L 218,525 L 222,529 L 222,530 L 232,541 L 232,542 L 235,545 L 235,546 L 245,557 L 245,558 L 248,561 L 248,562 L 253,567 L 253,568 L 257,572 L 257,573 L 267,584 L 267,585 L 270,588 L 270,589 L 280,600 L 280,601 L 283,604 L 283,605 L 288,610 L 288,611 L 297,621 L 297,622 L 299,623 L 299,624 L 302,627 L 302,628 L 307,633 L 307,634 L 310,637 L 310,638 L 315,643 L 315,644 L 319,648 L 319,649 L 329,660 L 329,661 L 332,664 L 332,665 L 334,666 L 334,667 L 342,676 L 342,677 L 345,680 L 345,681 L 356,693 L 358,697 L 359,697 L 361,699 L 361,700 L 363,702 L 362,703 L 358,703 L 356,701 L 353,700 L 351,698 L 349,698 L 347,696 L 344,696 L 343,695 L 341,695 L 340,696 L 334,696 L 333,697 L 325,699 L 322,701 L 320,701 L 315,704 L 313,704 L 311,706 L 308,707 L 308,708 L 306,710 L 305,710 L 305,712 L 302,715 L 297,715 L 296,716 L 288,716 L 287,715 L 284,715 L 282,713 L 282,709 L 283,707 L 288,702 L 288,701 L 293,697 L 293,696 L 296,693 L 296,692 L 300,687 L 302,683 L 302,678 L 301,677 L 289,677 L 286,674 L 285,671 L 283,669 L 280,669 L 278,670 L 278,671 L 275,674 L 271,681 L 267,685 L 263,687 L 261,687 L 257,684 L 255,680 L 255,678 L 254,677 L 254,675 L 252,671 L 252,668 L 251,667 L 251,665 L 249,661 L 246,663 L 243,663 L 242,664 L 230,664 L 226,661 L 225,661 L 221,657 L 220,653 L 218,650 L 218,645 L 217,644 L 217,641 L 216,640 L 216,637 L 215,636 L 215,630 L 213,626 L 212,616 L 210,612 L 209,602 L 207,598 L 207,592 L 205,588 L 204,579 L 202,575 L 201,564 L 199,561 L 199,555 L 197,551 L 197,547 L 196,546 L 195,537 L 194,536 L 194,533 L 193,532 L 193,527 L 191,523 L 191,518 L 190,517 L 190,514 L 189,513 L 189,510 L 188,509 L 188,503 L 186,499 L 185,489 L 184,488 Z M 175,443 L 177,441 L 196,441 L 197,440 L 210,440 L 211,439 L 217,439 L 218,438 L 223,438 L 224,437 L 250,437 L 251,436 L 253,436 L 254,437 L 258,437 L 259,436 L 261,436 L 262,437 L 268,437 L 269,436 L 276,437 L 277,436 L 291,436 L 292,435 L 295,435 L 296,434 L 300,433 L 301,432 L 301,430 L 305,425 L 313,426 L 318,429 L 321,429 L 322,430 L 327,430 L 330,428 L 331,424 L 333,422 L 333,420 L 337,417 L 344,417 L 345,418 L 348,418 L 353,421 L 356,421 L 359,423 L 362,423 L 363,424 L 366,424 L 367,425 L 374,425 L 375,426 L 376,425 L 390,424 L 391,423 L 394,423 L 397,421 L 400,421 L 410,416 L 413,413 L 414,413 L 417,410 L 418,410 L 421,407 L 422,407 L 422,406 L 424,405 L 432,397 L 436,396 L 437,395 L 442,398 L 442,400 L 444,402 L 444,405 L 445,406 L 445,408 L 447,412 L 447,418 L 448,419 L 448,422 L 449,423 L 449,444 L 447,448 L 447,451 L 440,459 L 437,460 L 431,466 L 431,468 L 430,469 L 431,485 L 429,487 L 428,491 L 425,496 L 425,498 L 423,501 L 422,506 L 420,509 L 420,512 L 417,517 L 417,520 L 415,522 L 415,525 L 412,530 L 412,533 L 409,538 L 409,540 L 407,542 L 407,544 L 402,549 L 402,550 L 400,552 L 399,552 L 399,553 L 397,554 L 397,555 L 395,557 L 394,557 L 394,558 L 391,561 L 390,563 L 390,570 L 391,572 L 396,577 L 396,578 L 401,583 L 401,584 L 406,589 L 406,590 L 410,594 L 410,595 L 414,599 L 414,600 L 418,604 L 418,605 L 428,616 L 430,620 L 430,622 L 429,623 L 429,627 L 430,628 L 431,633 L 436,643 L 436,645 L 439,650 L 439,652 L 441,655 L 441,657 L 445,664 L 445,666 L 447,669 L 447,671 L 449,673 L 449,675 L 455,686 L 455,688 L 458,692 L 458,694 L 460,696 L 461,699 L 466,706 L 468,711 L 472,715 L 472,716 L 470,718 L 467,718 L 466,717 L 460,717 L 456,715 L 450,715 L 449,714 L 444,714 L 443,713 L 439,713 L 438,712 L 428,712 L 427,711 L 419,711 L 418,710 L 404,710 L 403,709 L 383,709 L 379,707 L 375,707 L 368,700 L 366,696 L 357,686 L 357,685 L 349,676 L 349,675 L 346,672 L 346,671 L 341,666 L 341,665 L 338,662 L 338,661 L 336,660 L 336,659 L 333,656 L 333,655 L 330,652 L 330,651 L 325,646 L 325,645 L 317,636 L 317,635 L 314,632 L 314,631 L 309,626 L 309,625 L 306,622 L 306,621 L 304,620 L 304,619 L 301,616 L 301,615 L 298,612 L 298,611 L 293,606 L 293,605 L 290,602 L 290,601 L 288,600 L 288,599 L 285,596 L 285,595 L 282,592 L 282,591 L 277,586 L 277,585 L 274,582 L 274,581 L 269,576 L 269,575 L 266,572 L 266,571 L 261,566 L 261,565 L 258,562 L 258,561 L 253,556 L 253,555 L 250,552 L 250,551 L 245,546 L 245,545 L 237,536 L 237,535 L 234,532 L 234,531 L 228,525 L 226,521 L 220,515 L 220,514 L 217,511 L 217,510 L 213,506 L 213,505 L 209,501 L 209,500 L 205,496 L 205,495 L 201,491 L 201,490 L 196,485 L 194,481 L 190,477 L 190,476 L 188,475 L 188,474 L 185,471 L 185,470 L 181,466 L 181,465 L 178,461 L 177,452 L 175,448 Z"
                    fill="url(#skierGradient)" fill-rule="evenodd" stroke="none" />
            </svg>
            <div class="speed-lines">
                <div class="line"></div>
                <div class="line"></div>
                <div class="line"></div>
            </div>
        </div>
        <div class="loading-text">
            <h1 class="main-message">Good code loads fast.</h1>
            <h2 class="fetching-message">Fetching high-res bestagons...</h2>
        </div>
    </div>

    <div id="ui">
        <div class="glass-panel minimized" id="main-panel">
            <div class="panel-header">
                <div class="header-content">
                    <h1>POWFINDER 3D</h1>
                    <div class="subtitle">Binary Hex Piston Engine</div>
                </div>
                <button id="minimize-btn" class="minimize-btn" title="Minimize Panel">+</button>
            </div>

            <div class="panel-body">
                <div class="stats">
                    <!-- Basic Stats (Always Visible) -->
                    <div class="hud-item">
                        <span>LOCATION</span>
                        <span class="value" id="loc-val">SULZENAU, TIROL</span>
                    </div>
                    <div class="hud-item">
                        <span>FPS / ZOOM</span>
                        <span class="value" id="fps-counter">--</span>
                    </div>
                    <div class="hud-item">
                        <span>HEXAGONS</span>
                        <span class="value" id="hex-count">-- VISIBLE</span>
                    </div>
                    <div class="hud-item">
                        <span>PRECISION</span>
                        <span class="value">FLOAT16 (CM)</span>
                    </div>

                    <!-- Position & Debug (Collapsible) -->
                    <div class="collapsible-section collapsed" data-section="debug">
                        <div class="collapsible-header">
                            <span class="title">POSITION & DEBUG</span>
                            <span class="arrow">▼</span>
                        </div>
                        <div class="collapsible-content">
                            <div class="hud-item">
                                <span>TRIANGLES</span>
                                <span class="value" id="tri-count">-- / -- (--)</span>
                            </div>
                            <div class="hud-item">
                                <span>DRAW CALLS</span>
                                <span class="value" id="draw-stats">-- | G:-- | T:--</span>
                            </div>
                            <div class="hud-item">
                                <span>SECTOR</span>
                                <span class="value" id="sector-val">--</span>
                            </div>
                            <div class="hud-item">
                                <span>HEX</span>
                                <span class="value" id="hex-val">--</span>
                            </div>
                            <div class="hud-item" style="display: none;">
                                <span>WORLD XY</span>
                                <span class="value" id="world-val">--</span>
                            </div>
                            <div class="hud-item">
                                <span>TILE HEIGHT</span>
                                <span class="value" id="tile-height">--m</span>
                            </div>
                            <div class="hud-item">
                                <span>CAMERA HEIGHT</span>
                                <span class="value" id="camera-height">--m</span>
                            </div>
                        </div>
                    </div>

                    <!-- LOD Benchmarks (Collapsible) -->
                    <div class="collapsible-section collapsed" data-section="benchmarks">
                        <div class="collapsible-header">
                            <span class="title">LOD BENCHMARKS (MS)</span>
                            <span class="arrow">▼</span>
                        </div>
                        <div class="collapsible-content">
                            <div class="hud-item"
                                style="justify-content: space-between; font-family: 'Courier New', monospace; font-size: 10px;">
                                <span style="color: #aaa;">LINEAR SCAN</span>
                                <span class="value" id="bench-loop" style="color: #ff6b9d;">--</span>
                            </div>
                            <div class="hud-item"
                                style="justify-content: space-between; font-family: 'Courier New', monospace; font-size: 10px;">
                                <span style="color: #aaa;">QUAD TREE</span>
                                <span class="value" id="bench-tree" style="color: #74b9ff;">--</span>
                            </div>
                            <div class="hud-item"
                                style="justify-content: space-between; font-family: 'Courier New', monospace; font-size: 10px;">
                                <span style="color: #aaa;">GRID HASH</span>
                                <span class="value" id="bench-hash" style="color: #2ecc71;">--</span>
                            </div>
                        </div>
                    </div>

                    <!-- Granular LOD Tuning -->
                    <div class="collapsible-section collapsed" data-section="geometry">
                        <div class="collapsible-header">
                            <span class="title">GRANULAR LOD TUNING</span>
                            <span class="arrow">▼</span>
                        </div>
                        <div class="collapsible-content">
                            <!-- RENDER DISTANCE -->
                            <div class="hud-item" style="flex-direction: column; margin-top: 5px;">
                                <div style="display: flex; justify-content: space-between; width: 100%;">
                                    <span>RENDER DISTANCE</span>
                                    <span class="value" id="render-distance-val">20km</span>
                                </div>
                                <input type="range" id="render-distance-slider" min="1" max="50" step="1" value="20"
                                    style="width: 100%;">
                            </div>

                            <!-- TEXTURE UPGRADE -->
                            <div class="hud-item" style="flex-direction: column; margin-top: 10px;">
                                <div style="display: flex; justify-content: space-between; width: 100%;">
                                    <span>TEXTURE UPGRADE</span>
                                    <span class="value" id="tex-upgrade-val">2000m</span>
                                </div>
                                <input type="range" id="tex-upgrade-slider" min="0" max="5000" step="100" value="2000"
                                    style="width: 100%;">
                            </div>

                            <!-- UNIT -->
                            <div class="hud-item"
                                style="flex-direction: column; margin-top: 10px; border-top: 1px solid #333; padding-top: 10px;">
                                <span>UNIT (0 - <span id="lod-unit-end-val">700</span>m)</span>
                            </div>
                            <input type="range" id="lod-unit-end" min="0" max="5000" step="50" value="700"
                                style="width: 100%;">

                            <!-- SMALL -->
                            <div class="hud-item" style="flex-direction: column; margin-top: 10px;">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <span>SMALL</span>
                                </div>
                                <div style="display: flex; gap: 5px;">
                                    <input type="range" id="lod-small-start" min="0" max="5000" step="50" value="600"
                                        title="Start">
                                    <input type="range" id="lod-small-end" min="0" max="10000" step="50" value="2100"
                                        title="End">
                                </div>
                                <div
                                    style="display: flex; justify-content: space-between; font-size: 10px; color: #aaa;">
                                    <span id="lod-small-start-val">600m</span>
                                    <span id="lod-small-end-val">2100m</span>
                                </div>
                            </div>

                            <!-- MEDIUM -->
                            <div class="hud-item" style="flex-direction: column; margin-top: 10px;">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <span>MEDIUM</span>
                                </div>
                                <div style="display: flex; gap: 5px;">
                                    <input type="range" id="lod-medium-start" min="0" max="15000" step="100"
                                        value="1900" title="Start">
                                    <input type="range" id="lod-medium-end" min="0" max="25000" step="100" value="5100"
                                        title="End">
                                </div>
                                <div
                                    style="display: flex; justify-content: space-between; font-size: 10px; color: #aaa;">
                                    <span id="lod-medium-start-val">1900m</span>
                                    <span id="lod-medium-end-val">5100m</span>
                                </div>
                            </div>

                            <!-- LARGE -->
                            <div class="hud-item" style="flex-direction: column; margin-top: 10px;">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <span>LARGE (Start)</span>
                                </div>
                                <input type="range" id="lod-large-start" min="0" max="30000" step="100" value="4900"
                                    style="width: 100%;">
                                <div style="display: flex; justify-content: flex-start; font-size: 10px; color: #aaa;">
                                    <span id="lod-large-start-val">4900m</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>



                <!-- Toggles (Always Visible) -->
                <div class="hud-item"
                    style="display: flex; justify-content: space-between; align-items: center; margin-top: 15px; border-top: 1px solid #333; padding-top: 10px;">
                    <span>Gradient</span>
                    <div class="pill-toggle"
                        style="display: flex; background: rgba(20, 20, 20, 0.7); border-radius: 20px; border: 1px solid rgba(255, 255, 255, 0.1); padding: 4px; gap: 4px;">
                        <button class="pill-btn"
                            style="background: transparent; color: #ccc; border: none; padding: 6px 12px; border-radius: 16px; font-size: 0.8rem; cursor: pointer; transition: all 0.2s; font-family: 'Outfit', sans-serif;"
                            id="gradient-terrain">terrain</button>
                        <button class="pill-btn active"
                            style="background: #74b9ff; color: #fff; border: none; padding: 6px 12px; border-radius: 16px; font-size: 0.8rem; cursor: pointer; transition: all 0.2s; font-family: 'Outfit', sans-serif;"
                            id="gradient-slope">gradient</button>
                    </div>
                </div>


                <div class="hud-item"
                    style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
                    <span>PAUSE LOD UPDATES</span>
                    <input type="checkbox" id="lod-pause-toggle" style="pointer-events: auto;">
                </div>

                <div class="hud-item"
                    style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
                    <span>ADVANCED TOUCH</span>
                    <input type="checkbox" id="touch-controls-toggle" style="pointer-events: auto;">
                </div>

                <!-- Frametime Graph (Always Visible) -->
                <div class="hud-item frametime-item" style="margin-top: 15px;">
                    <canvas id="frametime-graph" width="640" height="80"></canvas>
                </div>

                <div class="info-panel">
                    <div class="tech-header">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="3">
                            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                        </svg>
                        Why Bestagons?
                    </div>
                    <div class="tech-description">
                        Utilizing a single GPU Draw Call for terrain mesh.
                        <span class="tech-spec">
                            - 1DrawCall / 15k Hexes<br>
                            - Zero DrawCall Overhead<br>
                            - 16-Byte "HEX4" Layout<br>
                            - Directional Skirt AO
                        </span>
                    </div>
                </div>

                <div class="console-panel">
                    <div class="console-header">
                        <span>STATUS LOG</span>
                        <button id="copy-log-btn" class="console-btn">COPY</button>
                    </div>
                    <div id="console-output" class="console-box">
                        <div class="log-line">Waiting for system...</div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    </div>

    <div class="legend glass-panel">
        <div class="legend-item">
            <div class="swatch" style="background:#555;"></div>
            < 10° PLAIN</div>
                <div class="legend-item">
                    <div class="swatch" style="background:#2ecc71;"></div> 10-25° EASY
                </div>
                <div class="legend-item">
                    <div class="swatch" style="background:#3498db;"></div> 25-30° MODERATE
                </div>
                <div class="legend-item">
                    <div class="swatch" style="background:#e74c3c;"></div> > 30° DANGER
                </div>
        </div>

        <div id="css-map-layer">
            <div id="css-world"></div>
        </div>
        <div id="canvas-container"></div>

        <script type="module" src="main.js?v=debug3"></script>
</body>

</html>



# ================================================================================
# FILE 5/13
# Path: frontend/app/lod_controller.js
# ================================================================================

// @atlas: The 'LODController' spatial indexing module. Evaluates and benchmarks different frustum culling strategies—implementing QuadTree bounding structures alongside linear scanning and GridHash algorithms. Vital for ensuring O(log N) or better performance when querying visibility for millions of instanced hexagons.
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


# ================================================================================
# FILE 6/13
# Path: frontend/app/main.js
# ================================================================================

// @atlas: The core 'PistonViewer' Three.js orchestrator. Manages the 60fps render loop, MapControls interaction, and instanced mesh generation. Uses a strict state machine (MOVING vs SINTERING) to preserve frame budgets while asynchronously dispatching Web Workers to decode and inject new 'HEX4' binary terrain tiles.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { HexSearch } from './search.js';
import { VRAMLedger } from './vram_ledger.js';
import { CacheManager } from './cache_manager.js';

// --- ENGINE STATE MACHINE & PERFORMANCE MONITORING ---
const APP_VERSION = 'v0.8.0';
const ENGINE_STATES = { MOVING_2D: 'MOVING_2D', MOVING_3D: 'MOVING_3D', SINTERING: 'SINTERING', STATIC: 'STATIC' };
// Per-state frame budgets (ms). Violations logged only when exceeded.
// MOVING targets 60fps. STATIC must never render at all (budget=0).
const STATE_BUDGETS_MS = { MOVING_2D: 16, MOVING_3D: 16, SINTERING: 1200, STATIC: 0 };
const PERF_VERBOSE_MAX = 5;    // First N violations: full-fat JSON with culprits
const PERF_STATS_WINDOW = 200; // After verbose cap: accumulate, then flush stats every N violations

// Silent pass-through — subsystem timing now handled by the aggregate
// frame-level [PERF_VIOLATION] system inside animate().
function track(_name, fn) { return fn(); }

// --- HEX COORDINATE SYSTEM (Rectangular Sectors) ---
const UNIT_HEX_PX = 32.0;
const METERS_PER_PIXEL = 0.2;
const UNIT_HEX_WIDTH_METERS = UNIT_HEX_PX * METERS_PER_PIXEL; // 6.4m
const SECTOR_WIDTH_METERS = 819.2; // 4096px

function worldToSectorID(worldX, worldY) {
    const sx = Math.floor(worldX / SECTOR_WIDTH_METERS);
    const sy = Math.floor(worldY / SECTOR_WIDTH_METERS);
    return { Q: sx, R: sy };
}

// --- CONFIG ---
const TILE_WIDTH_WORLD = SECTOR_WIDTH_METERS;
const TILE_HEIGHT_WORLD = SECTOR_WIDTH_METERS;
const SCALE_Z = 1.0;
// --- DEBUG OVERRIDE ---
// Default render distance: 20km (configurable via UI slider)
const DEFAULT_RENDER_DISTANCE = 4000;
const FLOOR_MODE = 'view-min';
const LOCK_FLOOR_ON_RISE = true;
const FLOOR_LOCK_THRESHOLD = 0.02;
const TILE_BOUNDS_MIN_Y = -10000;
const TILE_BOUNDS_MAX_Y = 10000;

const LIGHTING_DEFAULTS = {
    aoFloor: 0.0,
    aoPower: 1.0,
    lambert: 0.0,
    rim: 0.0,
    rimPower: 2.2,
    spec: 0.0,
    specPower: 30.0,
    slopeLight: 0.0,
};

class PistonViewer {
    constructor() {
        console.log(`[HEXAGONS] ${APP_VERSION} — loading...`);
        this.container = document.getElementById('canvas-container');
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0a); // Dark Grey

        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 10, 50000);
        this.camera.position.set(0, 800, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.container.appendChild(this.renderer.domElement);

        this.controls = new MapControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.screenSpacePanning = false;
        this.controls.minDistance = 100;
        this.controls.maxDistance = 50000;
        this.controls.maxPolarAngle = Math.PI / 2.1;

        // INTERACTION STATE TRACKING
        this.isUserInteracting = false;
        this.controls.addEventListener('start', () => {
            this.isUserInteracting = true;
            this.isMoving3D = true;
            this.resetLODs();
        });
        this.controls.addEventListener('end', () => {
            this.isUserInteracting = false;
            this.isMoving3D = false;
            this.lastInteractionTime = performance.now();
        });
        this.controls.addEventListener('change', () => {
            this.needsRender = true;
            // NOTE: We do NOT reset LODs here anymore to avoid oscillation loops
            // from our own camera altitude adjustments.
        });

        this.needsRender = true;
        this.lastLODCamPos = new THREE.Vector3().copy(this.camera.position);

        // Platform Detection
        this.isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        this.log(`Platform: ${this.isMobile ? 'Mobile' : 'Desktop'}`);

        // LOD Configurations
        this.LOD_CONFIG = {
            DESKTOP: {
                MOVING: { unitEnd: 0, smallStart: 0, smallEnd: 0, mediumStart: 0, mediumEnd: 0, largeStart: 0 },
                TARGET: { unitEnd: 2000, smallStart: 1980, smallEnd: 5000, mediumStart: 4980, mediumEnd: 10000, largeStart: 9980 }
            },
            MOBILE: {
                MOVING: { unitEnd: 0, smallStart: 0, smallEnd: 1000, mediumStart: 980, mediumEnd: 2500, largeStart: 2480 },
                TARGET: { unitEnd: 400, smallStart: 380, smallEnd: 2000, mediumStart: 1980, mediumEnd: 3500, largeStart: 3480 }
            }
        };

        // Initialize with MOVING preset
        const preset = this.isMobile ? this.LOD_CONFIG.MOBILE.MOVING : this.LOD_CONFIG.DESKTOP.MOVING;
        this.lodRanges = { ...preset };

        // Antisintering State
        this.lastInteractionTime = performance.now();
        this.isRefining = false;
        this.refineSpeed = 5000; // Snappy growth: 5km per frame (4 frames for full landscape)
        this.maxFrameTime = 500; // Allow a 0.5s pause for the "Snap" reward

        // Legacy/Sorting Support
        this.geoThresholds = [1200, 3500, 8500, 25000];

        // Texture High-Res Load Distance
        this.texThreshold = 2000;

        window.addEventListener('resize', this.onResize.bind(this));

        // Shared Geometry
        const side = UNIT_HEX_WIDTH_METERS / Math.sqrt(3);
        this.hexGeometry = this.createHexGeometry(side);
        this.flatGeometry = new THREE.PlaneGeometry(TILE_WIDTH_WORLD, TILE_HEIGHT_WORLD);
        this.flatGeometry.rotateX(-Math.PI / 2);

        this.tiles = new Map(); // Key: "q_r" -> Tile Object
        this.manifest = null;
        this.loadingTiles = new Set();
        this.loadQueue = [];
        this.upgradeQueue = [];
        this.instantiateQueue = []; // NEW: Results ready for main thread
        this.activeWorkerCount = 0; // NEW: Replaces isProcessingTile
        this.recentlyUpgradedTextures = []; // Track tiles that just got texture upgraded (for render spike correlation)
        this.lodTransitionInProgress = false; // Flag to suppress spike warnings during expected LOD transitions
        this.lastLodPreset = 'MOVING'; // Track if we're in MOVING or TARGET preset
        // this.isProcessingTile = false; // REMOVED
        // this.isUpgradingTex = false; // REMOVED

        this.loaderHidden = false;
        this.appStartTime = performance.now();
        this.materialsToUpdate = new Set(); // Changed to Set

        this.gradientMode = 1.0;
        this.heightFactor = 0.0;
        this.transSettings = { flatThresh: 5.0, riseStart: 6.0, riseEnd: 25.0, curve: 1.0 };
        this.worldOrigin = { x: 0, y: 0 };
        this.floorMode = FLOOR_MODE;
        this.floorState = { locked: false, value: 0.0, lastFactor: 0.0 };
        this.globalStats = { min: Infinity, max: -Infinity, avgSum: 0.0, baseSum: 0.0, count: 0 };
        this.frustum = new THREE.Frustum();
        this.projScreenMatrix = new THREE.Matrix4();
        this.renderSettings = { renderDistance: DEFAULT_RENDER_DISTANCE };

        // Debug/Stats
        this.fpsState = { lastSample: performance.now(), frames: 0 };
        this.fpsEl = document.getElementById('fps-counter');
        this.hexCountEl = document.getElementById('hex-count');
        this.tileHeightEl = document.getElementById('tile-height');
        this.cameraHeightEl = document.getElementById('camera-height');
        this.statsUpdateState = { lastUpdate: 0, interval: 500 };

        // 3D movement vs sintered state
        // - 3D moving: only build/render LOD0 (large, skirtless) for responsiveness.
        // - 3D sintered: allow building finer LODs once camera is settled.
        this.isMoving3D = false;
        this.wasMoving3D = false;
        this.sinterQueue = [];

        // Engine state machine (for structured perf logging)
        this.engineState = ENGINE_STATES.STATIC;
        this._perfViolationCount = 0;
        this._perfStats = {};  // Per-state rolling stats: { STATE: { min, max, sum, count } }
        this._texErrorCount = 0; // Dedup repeated texture decode failures
        this._frameCounter = 0;

        // Frametime Graph
        this.frametimeCanvas = document.getElementById('frametime-graph');
        this.frametimeCtx = this.frametimeCanvas ? this.frametimeCanvas.getContext('2d') : null;
        this.frametimeBuffer = new Array(640).fill(16.67); // 60fps baseline
        this.frametimeLastTime = performance.now();

        // LOD Pause Toggle
        this.lodPaused = false;

        this.lodPaused = false;

        this.initDebugConsole();
        this.initMinimizeButton();
        this.initCollapsibleSections();
        this.initLODSliders();
        this.updateFogAndClip();

        // WORKER SYSTEM
        this.workers = [];
        this.nextWorkerIdx = 0;
        this.pendingJobs = new Map(); // ID -> {resolve, reject}
        this.jobIdCounter = 0;
        this.initWorkers();

        // --- INFRASTRUCTURE: Telemetry & Cache Authority ---
        this.vramLedger = new VRAMLedger();
        this.cacheManager = new CacheManager(this.vramLedger);

        this.initWorld();
        this.animate();
        window.pistonViewer = this;
    }

    initWorkers() {
        // Create a pool based on concurrency (clamped to 4-6)
        const count = Math.min(6, Math.max(2, navigator.hardwareConcurrency || 4));
        // Workers initialized silently

        for (let i = 0; i < count; i++) {
            const w = new Worker('./tile_worker.js');
            w.onmessage = (e) => this.handleWorkerMessage(e);
            this.workers.push(w);
        }
    }

    handleWorkerMessage(e) {
        const { id, status, result, error } = e.data;
        const job = this.pendingJobs.get(id);
        if (!job) return;

        this.pendingJobs.delete(id);

        if (status === 'success') job.resolve(result);
        else job.reject(new Error(error));
    }

    postWorkerJob(type, data, transferables = []) {
        return new Promise((resolve, reject) => {
            const id = this.jobIdCounter++;
            this.pendingJobs.set(id, { resolve, reject });

            const w = this.workers[this.nextWorkerIdx];
            this.nextWorkerIdx = (this.nextWorkerIdx + 1) % this.workers.length;

            w.postMessage({ id, type, data }, transferables);
        });
    }

    log(msg, type = "info") {
        const el = document.getElementById('console-output');
        // In-app DOM console only — no browser console output

        if (!el) return;
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
    }

    initDebugConsole() {
        this.log("PistonViewer Initialized.", "success");
    }

    initMinimizeButton() {
        const btn = document.getElementById('minimize-btn');
        const panel = document.getElementById('main-panel');
        if (btn && panel) {
            btn.addEventListener('click', () => {
                panel.classList.toggle('minimized');
                btn.textContent = panel.classList.contains('minimized') ? '+' : '−';
            });
        }
    }

    initCollapsibleSections() {
        document.querySelectorAll('.collapsible-header').forEach(header => {
            header.addEventListener('click', () => {
                const section = header.parentElement;
                section.classList.toggle('collapsed');
            });
        });
    }

    initLODSliders() {
        // UNIT END
        const unitEnd = document.getElementById('lod-unit-end');
        if (unitEnd) {
            unitEnd.addEventListener('input', () => {
                this.lodRanges.unitEnd = parseInt(unitEnd.value);
                document.getElementById('lod-unit-end-val').textContent = unitEnd.value;
                this.needsRender = true;
            });
        }

        // SMALL
        const smallStart = document.getElementById('lod-small-start');
        const smallEnd = document.getElementById('lod-small-end');
        if (smallStart && smallEnd) {
            smallStart.addEventListener('input', () => {
                this.lodRanges.smallStart = parseInt(smallStart.value);
                document.getElementById('lod-small-start-val').textContent = smallStart.value + 'm';
                this.needsRender = true;
            });
            smallEnd.addEventListener('input', () => {
                this.lodRanges.smallEnd = parseInt(smallEnd.value);
                document.getElementById('lod-small-end-val').textContent = smallEnd.value + 'm';
                this.needsRender = true;
            });
        }

        // MEDIUM
        const medStart = document.getElementById('lod-medium-start');
        const medEnd = document.getElementById('lod-medium-end');
        if (medStart && medEnd) {
            medStart.addEventListener('input', () => {
                this.lodRanges.mediumStart = parseInt(medStart.value);
                document.getElementById('lod-medium-start-val').textContent = medStart.value + 'm';
                this.needsRender = true;
            });
            medEnd.addEventListener('input', () => {
                this.lodRanges.mediumEnd = parseInt(medEnd.value);
                document.getElementById('lod-medium-end-val').textContent = medEnd.value + 'm';
                this.needsRender = true;
            });
        }

        // LARGE
        const largeStart = document.getElementById('lod-large-start');
        if (largeStart) {
            largeStart.addEventListener('input', () => {
                this.lodRanges.largeStart = parseInt(largeStart.value);
                document.getElementById('lod-large-start-val').textContent = largeStart.value + 'm';
                this.needsRender = true;
            });
        }

        // Render Distance
        const rdSlider = document.getElementById('render-distance-slider');
        const rdVal = document.getElementById('render-distance-val');
        if (rdSlider) {
            rdSlider.value = this.renderSettings.renderDistance / 1000;
            if (rdVal) rdVal.textContent = (this.renderSettings.renderDistance / 1000) + "km";
            rdSlider.addEventListener('input', () => {
                this.renderSettings.renderDistance = parseInt(rdSlider.value) * 1000;
                if (rdVal) rdVal.textContent = rdSlider.value + "km";
                this.updateFogAndClip();
            });
        }

        // Texture Upgrade
        const texSlider = document.getElementById('tex-upgrade-slider');
        const texVal = document.getElementById('tex-upgrade-val');
        if (texSlider) {
            texSlider.value = this.texThreshold;
            if (texVal) texVal.textContent = this.texThreshold + "m";
            texSlider.addEventListener('input', () => {
                this.texThreshold = parseInt(texSlider.value);
                if (texVal) texVal.textContent = this.texThreshold + "m";
                this.needsLODUpdate = true;
            });
        }

        // Gradient Toggle
        const terrainBtn = document.getElementById('gradient-terrain');
        const gradientBtn = document.getElementById('gradient-slope');
        if (terrainBtn && gradientBtn) {
            terrainBtn.addEventListener('click', () => {
                this.gradientMode = 0.0;
                terrainBtn.classList.add('active');
                gradientBtn.classList.remove('active');
                // Standard color updates handled by CSS class now preferably, 
                // but let's maintain consistency with existing code
                terrainBtn.style.background = '#74b9ff';
                terrainBtn.style.color = '#fff';
                gradientBtn.style.background = 'transparent';
                gradientBtn.style.color = '#ccc';
            });
            gradientBtn.addEventListener('click', () => {
                this.gradientMode = 1.0;
                gradientBtn.classList.add('active');
                terrainBtn.classList.remove('active');
                gradientBtn.style.background = '#74b9ff';
                gradientBtn.style.color = '#fff';
                terrainBtn.style.background = 'transparent';
                terrainBtn.style.color = '#ccc';
            });
        }

        // LOD Pause Toggle
        const lodPauseToggle = document.getElementById('lod-pause-toggle');
        if (lodPauseToggle) {
            lodPauseToggle.addEventListener('change', (e) => {
                this.lodPaused = e.target.checked;
                this.log(this.lodPaused ? "LOD Updates PAUSED" : "LOD Updates RESUMED", "info");
            });
        }

        this.syncLODUI();
    }

    syncLODUI() {
        const r = this.lodRanges;
        const set = (id, val) => {
            const el = document.getElementById(id);
            const valEl = document.getElementById(id + '-val');
            if (el) el.value = val;
            if (valEl) valEl.textContent = Math.round(val) + (id.includes('start') || id.includes('end') ? 'm' : '');
        };

        set('lod-unit-end', r.unitEnd);
        set('lod-small-start', r.smallStart);
        set('lod-small-end', r.smallEnd);
        set('lod-medium-start', r.mediumStart);
        set('lod-medium-end', r.mediumEnd);
        set('lod-large-start', r.largeStart);
    }

    createHexGeometry(radius) {
        // 1. CAP GEOMETRY (Top Face Only)
        const capGeo = new THREE.CircleGeometry(radius, 6);
        capGeo.rotateX(-Math.PI / 2); // Lay flat

        // Add dummy aSideId to Cap (required for shared shader)
        const capLen = capGeo.attributes.position.count;
        capGeo.setAttribute('aSideId', new THREE.Float32BufferAttribute(new Float32Array(capLen).fill(0), 1));

        // 2. PARTIAL SKIRT GEOMETRY (SE, S, SW Only)
        // Manual construction to ensure clean Side IDs and no overhead
        // Flat Top: SE(2), S(3), SW(4).
        // Angles:
        // 0: E, 1: SE, 2: SW, 3: W, 4: NW, 5: NE (Standard CircleGeo order??)
        // Let's verify standard ThreeJS Circle/Cyl order:
        // Vert 0: (1, 0, 0) -> East
        // Vert 1: (0.5, 0, 0.866) -> SouthEast (Z+)
        // Vert 2: (-0.5, 0, 0.866) -> SouthWest
        // Vert 3: (-1, 0, 0) -> West
        // Vert 4: (-0.5, 0, -0.866) -> NorthWest
        // Vert 5: (0.5, 0, -0.866) -> NorthEast

        // Segments (Counter-Clockwise in Theta, but indices might be different):
        // Face 0: 0 -> 1 (East -> SE). This is SE Face? No, average is ESE.
        // Let's look at the edges required for SE, S, SW neighbors.
        // Neighbor SE (Index 2): Direction (1, -1) -> Angle ~ -30 deg? (North is +90? No).
        // Standard Map: N(0,-1) usually? No, here N is -Z.
        // SE is (+X, +Z).
        // Edge SE is the edge connecting East Vertex and SouthEast Vertex? No.
        // It's the edge perpendicular to the SE direction.
        // SE Direction: (+1, +1) approx.
        // The Edge "facing" SE is the one between E(0) and S(approx).

        // Let's rely on the visual check:
        // We want the "Bottom Right", "Bottom", "Bottom Left" faces on screen.
        // These are Verts 0->1, 1->2, 2->3.
        // 0->1: East to SouthEast. (SE Face)
        // 1->2: SouthEast to SouthWest. (South Face)
        // 2->3: SouthWest to West. (SW Face)

        // This matches our indices 2(SE), 3(S), 4(SW) perfectly if we treat 0 as start.
        // So we build 3 quads connecting:
        // Quad 0 (SE): Top(0,1) -> Bottom(0,1)
        // Quad 1 (S):  Top(1,2) -> Bottom(1,2)
        // Quad 2 (SW): Top(2,3) -> Bottom(2,3)

        const vertices = [];
        const indices = [];
        const sideIDs = [];

        const angles = [
            0,                  // 0: East
            Math.PI / 3,        // 1: SE
            2 * Math.PI / 3,    // 2: SW
            Math.PI             // 3: West
        ];

        let vIdx = 0;
        for (let i = 0; i < 3; i++) {
            const th1 = angles[i];
            const th2 = angles[i + 1];

            const x1 = Math.cos(th1) * radius; const z1 = Math.sin(th1) * radius;
            const x2 = Math.cos(th2) * radius; const z2 = Math.sin(th2) * radius;

            // Top (Y=0), Bottom (Y=-1)
            // 4 Verts per quad to allow distinct attributes if needed,
            // though we could share. Separate is safer for flat shading/normals.

            // BL, BR, TR, TL order for CCW face?
            // Top Edge: (x1,0,z1) -> (x2,0,z2)
            // Bottom Edge: (x1,-1,z1) -> (x2,-1,z2)

            // Push Vertices
            vertices.push(x1, 0, z1);   // 0: Top Left (Start)
            vertices.push(x2, 0, z2);   // 1: Top Right (End)
            vertices.push(x1, -1, z1);  // 2: Btm Left
            vertices.push(x2, -1, z2);  // 3: Btm Right

            // Faces (Standard Two-Triangle Quad)
            // 2, 1, 0
            // 2, 3, 1
            indices.push(vIdx + 2, vIdx + 1, vIdx + 0);
            indices.push(vIdx + 2, vIdx + 3, vIdx + 1);

            // Side ID (0, 1, 2)
            for (let k = 0; k < 4; k++) sideIDs.push(i);

            vIdx += 4;
        }

        const skirtGeo = new THREE.BufferGeometry();
        skirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        skirtGeo.setAttribute('aSideId', new THREE.Float32BufferAttribute(sideIDs, 1));
        skirtGeo.setIndex(indices);
        skirtGeo.computeVertexNormals(); // Nice to have for lighting

        return { capGeo, skirtGeo };
    }

    onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    updateFogAndClip() {
        const dist = this.renderSettings.renderDistance;
        const fogEnd = dist;
        const fogStart = dist * 0.6;
        if (!this.scene.fog) this.scene.fog = new THREE.Fog(0x0a0a0a, fogStart, fogEnd); // Match Bg
        this.scene.fog.near = fogStart;
        this.scene.fog.far = fogEnd;
        this.camera.far = dist + 2000;
        this.camera.updateProjectionMatrix();
    }

    async initWorld() {
        try {
            const res = await fetch('tile_manifest.json');
            this.manifest = await res.json();
            const { min_x, min_y } = this.manifest.bounds;
            this.worldOrigin = { x: min_x, y: min_y };

            // --- NEW: Spatial Grid Index (The "Phonebook") ---
            this.manifestGrid = new Map();
            for (const t of this.manifest.tiles) {
                // Post-calc world positions (Match worker's centering logic)
                t.lx = t.x - this.worldOrigin.x;
                t.lz = -(t.y - this.worldOrigin.y);

                // Store by "Q_R" for instant lookup
                this.manifestGrid.set(`${t.q}_${t.r}`, t);
            }

            // -----------------------------------------------

            // Preferred start: Stubai Ski Area buildings
            // These coordinates match STUBAI_LAT/LON in waffle_iron.py (sector 73, 252)
            const stubaiBuildingsX = 59817.9;
            const stubaiBuildingsY = 206666.2;
            const stubaiSector = worldToSectorID(stubaiBuildingsX, stubaiBuildingsY);
            const stubaiKey = `${stubaiSector.Q}_${stubaiSector.R}`;

            // Secondary: Ski tour area near Kühtai (47.1338°N, 11.5965°E)
            const skiTourX = 95855.9;
            const skiTourY = 222423.2;
            const skiTourSector = worldToSectorID(skiTourX, skiTourY);
            const skiTourKey = `${skiTourSector.Q}_${skiTourSector.R}`;

            let startX, startZ;
            if (this.manifestGrid.has(stubaiKey)) {
                // Stubai is in the baked area - use it
                startX = stubaiBuildingsX - this.worldOrigin.x;
                startZ = -(stubaiBuildingsY - this.worldOrigin.y);

            } else if (this.manifestGrid.has(skiTourKey)) {
                // Ski tour area is baked - use it
                startX = skiTourX - this.worldOrigin.x;
                startZ = -(skiTourY - this.worldOrigin.y);

            } else {
                // Fall back to manifest center
                const cenX = (this.manifest.bounds.min_x + this.manifest.bounds.max_x) * 0.5;
                const cenY = (this.manifest.bounds.min_y + this.manifest.bounds.max_y) * 0.5;
                startX = cenX - this.worldOrigin.x;
                startZ = -(cenY - this.worldOrigin.y);

            }

            this.camera.position.set(startX, 1200, startZ);
            this.controls.target.set(startX, 0, startZ);
            this.controls.update();

            // PRE-ALLOCATE GEOMETRIES
            const side = UNIT_HEX_WIDTH_METERS / Math.sqrt(3);
            const geos = this.createHexGeometry(side);
            this.capGeometry = geos.capGeo;
            this.skirtGeometry = geos.skirtGeo;

            this.flatGeometry = new THREE.PlaneGeometry(TILE_WIDTH_WORLD, TILE_HEIGHT_WORLD);
            this.flatGeometry.rotateX(-Math.PI / 2);

            this.essentialTilesTarget = 1;

            this.updateLOD();
        } catch (e) {
            console.error("Manifest error: " + e.message);
            this.log("Manifest error: " + e.message, "error");
        }
    }

    worldToAxialScale(x, y, s) {
        const h = UNIT_HEX_WIDTH_METERS * s;
        const A = (Math.sqrt(3) / 2) * h;
        const q = x / A;
        const r = (y - (q * 0.5 * h)) / h;
        return { q, r };
    }

    createTileMaterial(lodIdx, hasTexture, texture) {
        let material;
        if (hasTexture) {
            material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        } else {
            material = new THREE.MeshBasicMaterial({ color: 0xff00ff, side: THREE.DoubleSide });
        }
        if (!material.userData) material.userData = {};
        material.userData.isClone = true; // Mark as a clone for cleanup
        material.userData.lodIdx = lodIdx; // Store LOD index for shader logic if needed
        this.setupMaterialShader(material);
        return material;
    }

    createMeshFromWorkerData(lodData, material, includeSkirts = true) {
        if (!lodData || lodData.matrix.length === 0) return null;

        const num = lodData.matrix.length / 16;

        // Geometries
        const capG = this.capGeometry.clone();
        const skirtG = includeSkirts ? this.skirtGeometry.clone() : null;

        return (scale) => {
            capG.scale(scale, 1, scale);
            if (skirtG) skirtG.scale(scale, 1, scale);

            const capMesh = new THREE.InstancedMesh(capG, material, num);
            const skirtMesh = skirtG ? new THREE.InstancedMesh(skirtG, material, num) : null;

            // Assign Attributes from Worker
            capMesh.instanceMatrix = new THREE.InstancedBufferAttribute(lodData.matrix, 16);
            if (skirtMesh) skirtMesh.instanceMatrix = new THREE.InstancedBufferAttribute(lodData.matrix, 16);

            const meshes = [capMesh];
            if (skirtMesh) meshes.push(skirtMesh);

            meshes.forEach(m => {
                m.geometry.setAttribute('instanceNZ_1', new THREE.InstancedBufferAttribute(lodData.nz1, 4));
                m.geometry.setAttribute('instanceNZ_2', new THREE.InstancedBufferAttribute(lodData.nz2, 4));
                m.geometry.setAttribute('instanceSlopes', new THREE.InstancedBufferAttribute(lodData.slopes, 3));
                m.geometry.setAttribute('instanceDeltas', new THREE.InstancedBufferAttribute(lodData.deltas, 3));
                m.geometry.setAttribute('instanceNormal', new THREE.InstancedBufferAttribute(lodData.norms, 2));
            });

            const group = new THREE.Group();
            group.add(capMesh);
            if (skirtMesh) group.add(skirtMesh);

            group.userData.activeSkirts = skirtMesh ? lodData.activeSkirts : 0;
            group.frustumCulled = false;
            return group;
        };
    }

    setupMaterialShader(material) {
        // Force Three.js to treat this as a distinct program variant so we don't accidentally
        // reuse a cached MeshBasicMaterial program that didn't get our onBeforeCompile edits.
        // If you change shader code, bump this string.
        material.customProgramCacheKey = () => 'piston_hex_patch_v2';

        material.onBeforeCompile = function (shader) {
            this.userData.shader = shader;
            shader.uniforms.uHeightFactor = { value: 0.0 };
            shader.uniforms.uGradientMode = { value: 1.0 };
            shader.uniforms.uFloorOffset = { value: 0.0 }; // Initial fallback
            shader.uniforms.uTileSize = { value: SECTOR_WIDTH_METERS };
            shader.uniforms.uCameraPos = { value: new THREE.Vector3() };
            shader.uniforms.uLodRadii = { value: new THREE.Vector2(0.0, 100000.0) }; // Min, Max

            // UV Padding correction (64px padding on 4096px base)
            const pad = 64.0;
            const size = 4096.0;
            const total = size + pad * 2;
            shader.uniforms.uUvScale = { value: size / total };
            shader.uniforms.uUvOffset = { value: pad / total };

            shader.vertexShader = shader.vertexShader.replace('#include <common>', `
                #include <common>
                uniform float uHeightFactor;
                uniform float uGradientMode; // Added for vertex shader access
                uniform float uFloorOffset;
                uniform float uTileSize;
                uniform float uUvScale;
                uniform float uUvOffset;
                uniform vec3 uCameraPos;
                uniform vec2 uLodRadii;

                attribute vec4 instanceNZ_1;
                attribute vec4 instanceNZ_2;

                // NEW: Vec3 for Slopes/Deltas, Vec2 for Normal
                attribute vec3 instanceSlopes;
                attribute vec3 instanceDeltas;
                attribute vec2 instanceNormal; // (Nx, Nz)

                attribute float aSideId;

                varying vec3 vLocalPos;
                varying vec3 vWorldPos;
                varying float vSlope;
                varying float vIsTop;
                varying float vSkirtY;
                varying float vSideId;
                varying vec3 vMyNormal;
            `).replace('#include <begin_vertex>', `
                #include <begin_vertex>

                // INSTANCE-LEVEL CULLING (Check distance from instance center, not vertex)
                // Extract instance position from instanceMatrix (column 3)
                #ifdef USE_INSTANCING
                    vec3 instancePos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
                    vec3 worldInstancePos = (modelMatrix * vec4(instancePos, 1.0)).xyz;
                    float instDist = distance(worldInstancePos, uCameraPos);

                    // Cull entire instance if outside LOD range
                    if (instDist < uLodRadii.x || instDist > uLodRadii.y) {
                        gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
                        return;
                    }
                #endif

                float myH = instanceNZ_2.z - uFloorOffset;
                float animH = myH * uHeightFactor;

                bool isCap = (normal.y > 0.9);
                vIsTop = isCap ? 1.0 : 0.0;

                if (isCap) {
                    // CAP
                    transformed.y = 0.0 + animH;
                    vSlope = 0.0; // Caps follow texture color usually, or flat slope
                    vSkirtY = 0.0;
                    vSideId = -1.0;

                    // Decode Normal from [0, 1] -> [-1, 1]
                    float nx = instanceNormal.x * 2.0 - 1.0;
                    float nz = instanceNormal.y * 2.0 - 1.0;
                    float ny_sq = 1.0 - nx*nx - nz*nz;
                    float ny = sqrt(max(0.0, ny_sq));

                    vMyNormal = normalize(vec3(nx, ny, nz));

                } else {
                    // SKIRT
                    vSkirtY = -position.y; // 0 at top, 1 at bottom
                    vSideId = aSideId;

                    if (position.y > -0.1) {
                         transformed.y = animH;
                    } else {
                         // Select Delta based on Side ID (0=SE, 1=S, 2=SW)
                         float dVal = (aSideId < 0.5) ? instanceDeltas.x :
                                      (aSideId < 1.5) ? instanceDeltas.y : instanceDeltas.z;

                         // Fix: Convert Decimeters (Int16) to Meters (Float)
                         dVal *= 0.1;

                         transformed.y = animH - (dVal * uHeightFactor);
                    }

                    // Pick Slope for Gradient
                    float sVal = (aSideId < 0.5) ? instanceSlopes.x :
                                 (aSideId < 1.5) ? instanceSlopes.y : instanceSlopes.z;
                    vSlope = sVal;

                    vMyNormal = normal; // Skirt flat normal
                }

                #ifdef USE_INSTANCING
                    vLocalPos = (instanceMatrix * vec4(transformed, 1.0)).xyz;
                    vWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
                #else
                    vLocalPos = transformed;
                    vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
                #endif
            `).replace('#include <project_vertex>', `
                #ifdef USE_MAP
                    // Brute Force Planar Mapping at END of vertex shader to ensure vMapUv is set
                    vec3 tempPosUv = vec3(position);
                    #ifdef USE_INSTANCING
                        tempPosUv = (instanceMatrix * vec4(tempPosUv, 1.0)).xyz;
                    #endif
                    vec2 rawUv = (tempPosUv.xz / uTileSize) + 0.5;
                    vMapUv = rawUv * uUvScale + uUvOffset;
                #endif
                #include <project_vertex>
            `);

            shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
                #include <common>
                uniform float uTileSize;
                uniform float uUvScale;
                uniform float uUvOffset;
                uniform float uGradientMode;
                uniform vec3 uCameraPos;
                uniform vec2 uLodRadii;
                varying vec3 vLocalPos;
                varying vec3 vWorldPos;
                varying float vSlope;
                varying float vIsTop;
                varying float vSkirtY;
                varying float vSideId;

                vec3 gradientColor(float s) {
                    // Green: 30-35
                    // Yellow: 35-40
                    // Orange: 40-45
                    // Red: 45-55
                    // Violet: > 55
                    
                    if (s < 30.0) return vec3(0.0); // Transparent/Texture?
                    if (s < 35.0) return vec3(0.2, 0.8, 0.2); // Green
                    if (s < 40.0) return vec3(0.9, 0.9, 0.2); // Yellow
                    if (s < 45.0) return vec3(1.0, 0.6, 0.0); // Orange
                    if (s < 55.0) return vec3(0.9, 0.2, 0.2); // Red
                    return vec3(0.6, 0.2, 0.8); // Violet
                }
            `).replace('#include <map_fragment>', `
                #ifdef USE_MAP
                    // Recalculate planar UVs in Fragment to be 100% sure we bypass standard UVs
                    float u = (vLocalPos.x / uTileSize) + 0.5;
                    float v = (-vLocalPos.z / uTileSize) + 0.5; // Flip Z for North/South alignment 
                    vec2 planarUv = vec2(u, v) * uUvScale + uUvOffset;
                    
                    vec4 texColor = texture2D(map, planarUv);
                    
                    // LIGHTING
                    float ao = 1.0 - (vSkirtY * 0.4); 
                    float jitter = 1.0;
                    if (vIsTop < 0.5) jitter = 0.92 + (vSideId * 0.04); 
                    float lighting = ao * jitter;

                    // COLOR
                    vec3 baseColor = texColor.rgb;
                    if (vIsTop < 0.5) { // SKIRT
                         if (uGradientMode > 0.5 && vSlope >= 30.0) {
                             baseColor = gradientColor(vSlope);
                         } else {
                             baseColor *= 0.6; // Darken skirt
                         }
                    }
                    
                    diffuseColor = vec4(baseColor * lighting, 1.0);
                #endif
            `);
        };

        // Ensure recompilation picks up onBeforeCompile + customProgramCacheKey.
        material.needsUpdate = true;
    }

    updateGlobalStats(stats) {
        if (!stats) return;
        this.globalStats.min = Math.min(this.globalStats.min, stats.min);
        this.globalStats.max = Math.max(this.globalStats.max, stats.max);
        this.globalStats.avgSum += stats.avg;
        this.globalStats.baseSum += stats.base;
        this.globalStats.count++;
    }

    updateRenderStats(now) {
        if (now - this.statsUpdateState.lastUpdate < 500) return;
        this.statsUpdateState.lastUpdate = now;

        let capCount = 0;
        let skirtCount = 0;

        for (const t of this.tiles.values()) {
            if (t.mesh && t.mesh.isGroup) {
                // Caps are always first child, skirts second
                // Iterate through all children, as each LOD is a group of cap/skirt
                t.mesh.children.forEach(lodGroup => {
                    if (lodGroup.isGroup) {
                        const capMesh = lodGroup.children[0];
                        const skirtMesh = lodGroup.children[1];
                        if (capMesh && capMesh.visible) capCount += capMesh.count;
                        if (skirtMesh && skirtMesh.visible) skirtCount += (lodGroup.userData.activeSkirts || 0);
                    }
                });
            }
        }

        const countEl = document.getElementById('hex-count');
        if (countEl) {
            countEl.innerHTML = `
                <span style="color: #00d2ff">${capCount.toLocaleString()} TOPS</span> | 
                <span style="color: #ff7675">${skirtCount.toLocaleString()} SKIRTS</span>
            `;
        }
    }

    updateFps() {
        if (!this.fpsEl) return;
        const now = performance.now();
        this.fpsState.frames += 1;
        const elapsed = now - this.fpsState.lastSample;
        if (elapsed < 500) return;
        const fps = (this.fpsState.frames * 1000) / elapsed;
        const dist = this.camera.position.distanceTo(this.controls.target);
        this.fpsEl.textContent = `FPS: ${fps.toFixed(0)} | Zoom: ${dist.toFixed(0)}`;
        this.fpsState.frames = 0;
        this.fpsState.lastSample = now;
    }

    updateFrametimeGraph() {
        if (!this.frametimeCtx) return;

        const now = performance.now();
        const frametime = now - this.frametimeLastTime;
        this.frametimeLastTime = now;

        // Update buffer (shift left, add new value on right)
        this.frametimeBuffer.shift();
        this.frametimeBuffer.push(frametime);

        const ctx = this.frametimeCtx;
        const width = this.frametimeCanvas.width;
        const height = this.frametimeCanvas.height;

        // Clear canvas
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, width, height);

        // Draw grid lines
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 1;
        // 16.67ms line (60fps)
        const y60 = height - (16.67 / 50) * height;
        ctx.beginPath();
        ctx.moveTo(0, y60);
        ctx.lineTo(width, y60);
        ctx.stroke();
        // 33.33ms line (30fps)
        const y30 = height - (33.33 / 50) * height;
        ctx.beginPath();
        ctx.moveTo(0, y30);
        ctx.lineTo(width, y30);
        ctx.stroke();

        // Draw frametime graph
        ctx.strokeStyle = '#74b9ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < this.frametimeBuffer.length; i++) {
            const ft = Math.min(this.frametimeBuffer[i], 50); // Cap at 50ms for display
            const x = i;
            const y = height - (ft / 50) * height;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Draw labels
        ctx.fillStyle = '#666';
        ctx.font = '10px monospace';
        ctx.fillText('16.67ms (60fps)', 5, y60 - 3);
        ctx.fillText('33.33ms (30fps)', 5, y30 - 3);
    }

    // --- CORE LOOP ---

    updateLOD() {
        if (!this.manifestGrid || this.lodPaused) {

            return;
        }

        const camPos = this.camera.position;
        const distLimit = this.renderSettings.renderDistance; // e.g. 4000m
        const secW = SECTOR_WIDTH_METERS;

        // 1. Where is the camera in UTM space?
        const utmX = camPos.x + this.worldOrigin.x;
        const utmY = -camPos.z + this.worldOrigin.y;

        const centerQ = Math.floor(utmX / secW);
        const centerR = Math.floor(utmY / secW);

        // 2. How many tiles out do we need to check?
        const radius = Math.ceil((distLimit + 1000) / secW);

        if (Math.random() < 0.01) {

        }

        // 3. Collect ONLY nearby candidates
        const candidates = [];

        for (let q = centerQ - radius; q <= centerQ + radius; q++) {
            for (let r = centerR - radius; r <= centerR + radius; r++) {
                const key = `${q}_${r}`;
                const t = this.manifestGrid.get(key);
                if (!t) {
                    // console.log(`Missing tile ${key}`);
                    continue;
                }

                // Fast Distance Check (Squared)
                const dx = t.lx - camPos.x;
                const dz = t.lz - camPos.z;
                const dSq = dx * dx + dz * dz;

                // Hard Limit Check (Render Distance + Buffer)
                if (dSq > (distLimit + 2000) ** 2) {
                    // console.log(`Tile ${key} too far: ${Math.sqrt(dSq).toFixed(0)}m`);
                    continue;
                }

                t.d = Math.sqrt(dSq);
                candidates.push(t);
            }
        }

        if (candidates.length === 0 && Math.random() < 0.05) {
            // No candidates — silent (expected during extreme zoom-out)
            const t = this.manifestGrid.get(`${centerQ}_${centerR}`);
            if (t) {
                const dx = t.lx - camPos.x;
                const dz = t.lz - camPos.z;
                void 0; // debug: Center tile distance = Math.sqrt(dx*dx+dz*dz)
            } else {
                void 0; // debug: Center tile not in manifest
            }
        }

        // 4. Sort ONLY the nearby candidates
        candidates.sort((a, b) => a.d - b.d);

        const camDir = new THREE.Vector3();
        this.camera.getWorldDirection(camDir);
        camDir.y = 0; camDir.normalize();

        const processedKeys = new Set();

        for (const t of candidates) {
            const key = `${t.q}_${t.r}`;
            processedKeys.add(key);

            const tile = this.tiles.get(key);

            // Direction Check
            const toTile = new THREE.Vector3(t.lx - camPos.x, 0, t.lz - camPos.z).normalize();
            const dot = camDir.dot(toTile);

            const isBehindGeo = (dot < 0.34);
            const isEffectivelyFrontTex = ((dot > -0.2) || (t.d < this.texThreshold)) && (t.d < 5000);

            let nominalLOD = 0;
            if (t.d < this.geoThresholds[0]) nominalLOD = 3;
            else if (t.d < this.geoThresholds[1]) nominalLOD = 2;
            else if (t.d < this.geoThresholds[2]) nominalLOD = 1;

            let targetLOD = nominalLOD;
            if (isBehindGeo) targetLOD = 0;

            if (!tile && !this.loadingTiles.has(key)) {
                if (t.d < 5000) {
                    this.loadingTiles.add(key);

                    this.loadQueue.push({ t, targetLOD, loadFullTexNow: isEffectivelyFrontTex });
                }
            } else if (tile) {
                if (!tile.isTransitioning) this.swapGeometry(tile, targetLOD);
                // Skip texture upgrades during 3D movement - only LOD0 geometry matters anyway
                // Upgrades will resume once camera settles (not moving3D)
                if (!this.isMoving3D && isEffectivelyFrontTex && !tile.isFullTex && !tile.loadingTex && !tile.queuedForUpgrade) {
                    tile.queuedForUpgrade = true;
                    this.upgradeQueue.push(tile);
                }
            }
        }

        // 5. Cleanup: Unload tiles that are NO LONGER in our candidate list
        for (const key of this.tiles.keys()) {
            if (!processedKeys.has(key)) {
                this.unloadTile(key);
            }
        }

        this.processQueues();
        this.checkInitialLoad(candidates);
    }

    checkInitialLoad(sorted) {
        if (this.loaderHidden) return;
        // If we have successfully instantiated at least 1 tile, hide the loader.
        // The rest will pop in.
        let operational = 0;
        for (const t of this.tiles.values()) {
            if (t.mesh) operational++;
        }

        if (operational >= 1) this.hideLoader();
    }

    processQueues() {
        const maxConcurrent = this.workers.length;
        const ESTIMATED_TILE_VRAM = 300 * 1024; // ~300 KB geometry + low-res texture

        this.cacheManager.beginTurn();

        // Sort closest-first so the LRU swap logic can break early:
        // if the closest new tile isn't worth swapping, nothing behind it is either.
        this.loadQueue.sort((a, b) => a.t.d - b.t.d);

        while (this.activeWorkerCount < maxConcurrent && this.loadQueue.length > 0) {
            const task = this.loadQueue.shift();
            const key = `${task.t.q}_${task.t.r}`;

            // Hygiene
            if (this.tiles.has(key) || task.t.d > this.renderSettings.renderDistance + 1000) {
                this.loadingTiles.delete(key);
                continue;
            }

            // --- LRU CACHE LOGIC ---
            if (!this.cacheManager.canAllocate(ESTIMATED_TILE_VRAM)) {
                // Budget is full. Only load if this tile is more valuable
                // than the worst loaded tile (distance + frustum check).
                this.projScreenMatrix.multiplyMatrices(
                    this.camera.projectionMatrix, this.camera.matrixWorldInverse);
                this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

                const swapped = this.cacheManager.requestSwap(
                    task.t.d,
                    this.camera.position,
                    this.frustum,
                    this.tiles,
                    this.unloadTile.bind(this)
                );

                if (!swapped) {
                    // What we have is already optimal. Drain the rest of the
                    // queue — since it's sorted closest-first, nothing behind
                    // this tile can swap either.
                    this.loadingTiles.delete(key);
                    for (const remaining of this.loadQueue) {
                        this.loadingTiles.delete(`${remaining.t.q}_${remaining.t.r}`);
                    }
                    this.loadQueue.length = 0;
                    break;
                }
            }

            // Record download (flags re-downloads of previously evicted tiles)
            this.cacheManager.recordDownload(key);

            this.activeWorkerCount++;
            this.fetchTileOnWorker(task).then(result => {
                this.activeWorkerCount--;
                if (result) this.instantiateQueue.push(result);
                this.processQueues(); // Keep the pipe full
            });
        }

        // 2. Texture Upgrades (Lower Priority)
        // A full-res 4224×4224 RGBA texture is ~67 MB — must pre-gate.
        const ESTIMATED_FULL_TEX_VRAM = 67 * 1024 * 1024;

        if (!this.isMoving3D && this.activeWorkerCount < maxConcurrent && this.loadQueue.length === 0 && this.upgradeQueue.length > 0) {
            const tile = this.upgradeQueue.shift();
            tile.queuedForUpgrade = false;
            const tileKey = `${tile.q}_${tile.r}`;

            // Budget check for texture upgrade
            if (!this.cacheManager.canAllocate(ESTIMATED_FULL_TEX_VRAM)) {
                this.projScreenMatrix.multiplyMatrices(
                    this.camera.projectionMatrix, this.camera.matrixWorldInverse);
                this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

                // Try up to 3 swaps to free enough for the ~67 MB texture
                let attempts = 0;
                while (!this.cacheManager.canAllocate(ESTIMATED_FULL_TEX_VRAM) && attempts < 3) {
                    const swapped = this.cacheManager.requestSwap(
                        Infinity, // only evict out-of-frustum tiles for tex upgrades
                        this.camera.position,
                        this.frustum,
                        this.tiles,
                        this.unloadTile.bind(this),
                        tileKey // don't evict the tile we're upgrading
                    );
                    if (!swapped) break;
                    attempts++;
                }

                if (!this.cacheManager.canAllocate(ESTIMATED_FULL_TEX_VRAM)) {
                    this.cacheManager.endTurn();
                    return; // Will retry next frame
                }
            }

            this.activeWorkerCount++;
            this.upgradeTexture(tile).finally(() => {
                this.activeWorkerCount--;
                this.processQueues();
            });
        }

        this.cacheManager.endTurn();
    }

    async fetchTileOnWorker(task) {
        try {
            const { t } = task;
            const lowTexUrl = `aerial_tiles/low/sector_${t.q}_${t.r}.webp`;
            const binUrl = `tiles_bin/sector_${t.q}_${t.r}.bin?v=6`;

            const workerData = await this.postWorkerJob('LOAD_TILE', {
                q: t.q, r: t.r,
                lx: t.lx, lz: t.lz,
                texUrl: lowTexUrl,
                binUrl: binUrl
            });

            // (silent — structured perf logging only)
            // Return data for instantiation frame
            return { task, workerData };

        } catch (e) {
            console.error("Tile Fetch Error", e);
            this.loadingTiles.delete(`${task.t.q}_${task.t.r}`);
            return null;
        }
    }

    processInstantiationQueue() {
        // BUDGET: Instantiate 1 tile per frame to maintain 60FPS
        // Or 2 if we are feeling brave. Start with 1.
        if (this.instantiateQueue.length === 0) return;

        // TIME SLICING: Do as many as fit in 2ms
        const start = performance.now();
        while (this.instantiateQueue.length > 0) {
            const job = this.instantiateQueue.shift();
            track('instantiateTile', () => this.instantiateTile(job.task, job.workerData));

            if (performance.now() - start > 2.0) break;
        }
    }

    // Moved Mesh Creation Logic Here
    instantiateTile(task, workerData) {
        const { t, loadFullTexNow } = task;
        const key = `${t.q}_${t.r}`;

        // Final Hygiene Check (Camera might have moved while worker was working)
        if (this.tiles.has(key)) return;

        // --- LEDGER: Track network payload from worker response ---
        if (workerData.networkBytes) {
            this.vramLedger.addNetworkPayload(key, workerData.networkBytes);
        }

        try {
            // 1. Texture Strategy (One texture per tile)
            const tex = (loadFullTexNow && t.fullTex) ? t.fullTex : workerData.texture;

            // 2. Create ONE material for this entire tile (shared across LODs)
            // This cuts shader compilation overhead by 75%
            let initialTex = null;
            if (tex) {
                initialTex = new THREE.CanvasTexture(tex);
                initialTex.colorSpace = THREE.SRGBColorSpace; // Fix "Ghostly Hue"
                initialTex.flipY = false;
            }
            const sharedMaterial = this.createTileMaterial(0, !!tex, initialTex);
            this.materialsToUpdate.add(sharedMaterial);

            const angle = this.controls.getPolarAngle() * 180 / Math.PI;
            const isVis = (angle >= 5.5);

            const meshGroup = new THREE.Group();

            for (let lodIdx = 0; lodIdx < 4; lodIdx++) {
                const lodData = workerData.lods[lodIdx];
                if (!lodData) continue;
                if (this.isMoving3D && lodIdx !== 0) continue;

                // Use the SHARED material, but stamp userData so logic still knows which layer is which
                // Note: We clone lightly only if we need unique per-LOD uniforms, but currently we don't.
                // The vertex shader handles the layer logic mostly via attributes.
                // Only "uLodRadii" is per material... ah wait.
                // If uLodRadii is per material, we DO need clones or unique materials if we want CPU culling per layer?
                // Actually, our loop updates uLodRadii per material based on userData.lodIdx.
                // So we DO need separate material instances if we want independent uniforms.
                // UNLESS we use "instanced uniforms" or simply clone() which is cheap (shares program).

                const layerMaterial = sharedMaterial.clone();
                // Ensure unique userData for each clone so uniform updates don't conflict
                layerMaterial.userData = { ...sharedMaterial.userData };
                layerMaterial.userData.lodIdx = lodIdx;
                layerMaterial.userData.shader = null;
                // NOTE: Material.clone() does not reliably carry over onBeforeCompile/customProgramCacheKey
                // across Three.js versions/builds. We must re-attach our shader patch on every clone,
                // otherwise height + UV mapping + GPU LOD culling silently fall back to default shaders.
                this.setupMaterialShader(layerMaterial);
                this.materialsToUpdate.add(layerMaterial);

                // Setup Geometry
                // IMPORTANT: LOD ordering must match baker layer order in hex_backend/waffle_iron.py.
                // lodIdx 0..3 map to scales [24, 6, 3, 1] (large -> unit).
                // If you change baker order, update tile_worker.js and all LOD ranges here.
                const includeSkirts = (lodIdx !== 0);
                const meshScale = [24.0, 6.0, 3.0, 1.0][lodIdx];

                const makeMesh = this.createMeshFromWorkerData(lodData, layerMaterial, includeSkirts);
                if (makeMesh) {
                    const finalMesh = makeMesh(meshScale);
                    if (finalMesh) {
                        // store activeSkirts for debug
                        finalMesh.userData.activeSkirts = lodData.activeSkirts;
                        meshGroup.add(finalMesh);
                    }
                }
            }

            meshGroup.position.set(t.lx, 0, t.lz);

            // Container for both Flat and 3D
            const containerGroup = new THREE.Group();

            // Flat Mesh - Needs its own material clone to avoid sharing LOD culling uniforms
            const flatMaterial = sharedMaterial.clone();
            flatMaterial.userData.lodIdx = -1; // -1 means "Always Render" (within frustum)
            this.setupMaterialShader(flatMaterial);
            this.materialsToUpdate.add(flatMaterial);

            const flatMesh = new THREE.Mesh(this.flatGeometry, flatMaterial);
            flatMesh.position.set(t.lx, 0, t.lz);
            // flatMesh.rotation.x = -Math.PI / 2; // REMOVED: Geometry is likely already XZ or oriented correctly
            flatMesh.visible = !isVis;
            t.flatMesh = flatMesh;
            containerGroup.add(flatMesh); // Add flat mesh to scene container

            meshGroup.visible = isVis;
            t.mesh = meshGroup;
            containerGroup.add(meshGroup);

            this.scene.add(containerGroup);
            // Force GPU Upload/Compile of geometry and shaders
            // This prevents the "Stutter on 3D Switch" by paying the cost now, 1 tile per frame.
            this.renderer.compile(containerGroup, this.camera);

            containerGroup.visible = true;
            this.scene.add(containerGroup);
            this.needsRender = true;

            const half = TILE_WIDTH_WORLD / 2;
            const bounds = new THREE.Box3(
                new THREE.Vector3(t.lx - half, TILE_BOUNDS_MIN_Y, t.lz - half),
                new THREE.Vector3(t.lx + half, TILE_BOUNDS_MAX_Y, t.lz + half)
            );

            // GATHER MATERIALS for cleanup/tracking
            const gatheredMaterials = [];
            containerGroup.traverse((child) => {
                if (child.isMesh && child.material) gatheredMaterials.push(child.material);
            });

            const tileObj = {
                q: t.q, r: t.r, lx: t.lx, lz: t.lz,
                mesh: meshGroup,           // 3D LOD content
                container: containerGroup, // Scene root for this tile
                flatMesh, material: sharedMaterial, bounds,
                hexDataLayers: workerData.layers,
                lods: workerData.lods,
                lodBuilt: [true, !this.isMoving3D, !this.isMoving3D, !this.isMoving3D],
                needsSinteredBuild: this.isMoving3D,
                stats: workerData.stats,
                center: workerData.center,
                currentGeoLOD: -1,
                isFullTex: false,
                loadingTex: false,
                queuedForUpgrade: false,
                queuedForUpgrade: false,
                isTransitioning: false,
                clonedMaterials: gatheredMaterials
            };
            this.tiles.set(key, tileObj);
            this.updateGlobalStats(workerData.stats);

            // --- LEDGER: Register tile's GPU footprint ---
            // Geometry bytes pre-computed on worker thread (Graft 3)
            const geometryBytes = workerData.geometryBytes || 0;
            // Texture: low-res bitmap (worker returns ImageBitmap → CanvasTexture)
            let textureBytes = 0;
            if (workerData.texture && workerData.texture.width) {
                textureBytes = workerData.texture.width * workerData.texture.height * 4;
            }
            this.vramLedger.register(key, {
                geometryBytes, textureBytes,
                q: t.q, r: t.r, lx: t.lx, lz: t.lz,
            });

            if (loadFullTexNow && !tileObj.isFullTex && !tileObj.loadingTex && !tileObj.queuedForUpgrade) {
                tileObj.queuedForUpgrade = true;
                this.upgradeQueue.push(tileObj);
            }

            this.loadingTiles.delete(key);

        } catch (e) {
            console.error("Instantiation Error", key, e);
            this.loadingTiles.delete(key);
        }
    }

    buildSinteredLods(tile) {
        if (!tile?.mesh || !tile.lods) return;
        if (!tile.needsSinteredBuild) return;

        const sintStart = performance.now();
        let lodsBuilt = 0;

        for (let lodIdx = 1; lodIdx < 4; lodIdx++) {
            if (tile.lodBuilt?.[lodIdx]) continue;
            const lodData = tile.lods[lodIdx];
            if (!lodData) continue;

            const layerMaterial = tile.material.clone();
            layerMaterial.userData = { ...tile.material.userData };
            layerMaterial.userData.lodIdx = lodIdx;
            layerMaterial.userData.shader = null;
            this.setupMaterialShader(layerMaterial);
            this.materialsToUpdate.add(layerMaterial);

            const includeSkirts = (lodIdx !== 0);
            const meshScale = [24.0, 6.0, 3.0, 1.0][lodIdx];
            const makeMesh = this.createMeshFromWorkerData(lodData, layerMaterial, includeSkirts);
            if (makeMesh) {
                const finalMesh = makeMesh(meshScale);
                if (finalMesh) {
                    finalMesh.userData.activeSkirts = lodData.activeSkirts;
                    tile.mesh.add(finalMesh);
                    lodsBuilt++;
                }
            }
            if (tile.lodBuilt) tile.lodBuilt[lodIdx] = true;
        }

        // (sintered-build timing captured by aggregate frame violation)

        tile.needsSinteredBuild = false;
        this.needsRender = true;
    }

    async upgradeTexture(tile) {
        tile.loadingTex = true;
        const key = `${tile.q}_${tile.r}`;
        const url = `aerial_tiles/full/sector_${tile.q}_${tile.r}.webp`;
        try {
            const texStart = performance.now();
            const result = await this.postWorkerJob('LOAD_TEXTURE', { url });
            const texLoadTime = performance.now() - texStart;

            // --- LEDGER: Track upgraded texture network payload ---
            if (result.networkBytes) {
                this.vramLedger.addNetworkPayload(key, { bin: 0, tex: result.networkBytes });
            }

            const fullTex = new THREE.CanvasTexture(result.bitmap);
            fullTex.colorSpace = THREE.SRGBColorSpace;
            fullTex.flipY = false;

            const assignStart = performance.now();

            // --- INCINERATOR: Dispose old low-res texture before replacing ---
            if (tile.material.map && tile.material.map !== fullTex) {
                tile.material.map.dispose();
            }

            // ASSIGN TO MAIN MATERIAL
            tile.material.map = fullTex;
            tile.material.needsUpdate = true;

            // ASSIGN TO ALL CLONED MATERIALS (old map refs disposed via main material above)
            let clonedCount = 0;
            if (tile.clonedMaterials) {
                tile.clonedMaterials.forEach(m => {
                    // Clones share the same texture instance, no need to dispose each
                    m.map = fullTex;
                    m.needsUpdate = true;
                    clonedCount++;
                });
            }

            const assignTime = performance.now() - assignStart; // Measure ENTIRE assignment block in ms

            // --- LEDGER: Update texture VRAM (old low-res → new full-res) ---
            const newTexBytes = result.bitmap.width * result.bitmap.height * 4;
            this.vramLedger.updateTexture(key, newTexBytes);

            tile.isFullTex = true;

            // Track for render spike correlation
            this.recentlyUpgradedTextures.push({ q: tile.q, r: tile.r, time: performance.now() });

            // (tex-upgrade timing captured by aggregate frame violation)

            this.needsRender = true;
        } catch (e) {
            this._texErrorCount++;
            if (this._texErrorCount <= 3) {
                console.warn(`[TEX_FAIL] ${tile.q},${tile.r}: ${e.message}`);
                if (this._texErrorCount === 3) console.warn('[TEX_FAIL] Further texture errors suppressed.');
            }
        }
        tile.loadingTex = false;
    }

    // parseBinaryV3 removed (handled by worker)

    swapGeometry(tile, newLOD) {
        // Stacked Mode: No need to swap geometry!
        // The shader handles LOD via uLodRadii.
        // We just ensure visibility matches camera angle.
        const angle = this.controls.getPolarAngle() * 180 / Math.PI;
        const isVis = (angle >= 5.5);
        if (tile.mesh) tile.mesh.visible = isVis;
    }

    unloadTile(key) {
        const tile = this.tiles.get(key);
        if (!tile) return;

        // --- INCINERATOR: Rigorous GPU Disposal Pipeline ---
        this._disposeTileGPU(tile);

        // --- LEDGER: Deregister VRAM tracking ---
        this.vramLedger.deregister(key);

        this.tiles.delete(key);
        this.loadingTiles.delete(key);
    }

    /**
     * THE INCINERATOR — Rigorous GPU resource teardown.
     * Explicitly disposes all WebGL resources (BufferGeometry, Material, Texture)
     * and nullifies references to force immediate GPU memory release.
     * @param {object} tile - Tile object from this.tiles
     */
    _disposeTileGPU(tile) {
        // 1. Remove from scene FIRST (prevents any further draws)
        if (tile.container) this.scene.remove(tile.container);

        // 2. Deep-traverse all 3D meshes — dispose geometry, materials, textures
        if (tile.mesh) {
            tile.mesh.traverse(obj => {
                if (obj.isMesh) {
                    if (obj.geometry) {
                        obj.geometry.dispose();
                    }
                    // Array-safe material disposal (Graft 2)
                    const materials = obj.material
                        ? (Array.isArray(obj.material) ? obj.material : [obj.material])
                        : [];
                    for (const mat of materials) {
                        if (mat.map) { mat.map.dispose(); mat.map = null; }
                        this.materialsToUpdate.delete(mat);
                        mat.dispose();
                    }
                }
            });
        }

        // 3. Flat mesh
        if (tile.flatMesh) {
            if (tile.flatMesh.geometry) tile.flatMesh.geometry.dispose();
            if (tile.flatMesh.material) {
                if (tile.flatMesh.material.map) {
                    tile.flatMesh.material.map.dispose();
                    tile.flatMesh.material.map = null;
                }
                this.materialsToUpdate.delete(tile.flatMesh.material);
                tile.flatMesh.material.dispose();
            }
        }

        // 4. Shared material (may have its own texture ref)
        if (tile.material) {
            if (tile.material.map) {
                tile.material.map.dispose();
                tile.material.map = null;
            }
            this.materialsToUpdate.delete(tile.material);
            tile.material.dispose();
        }

        // 5. Cloned materials list (catch any stragglers not in traversal)
        if (tile.clonedMaterials) {
            tile.clonedMaterials.forEach(m => {
                this.materialsToUpdate.delete(m);
                if (m.map) { m.map.dispose(); m.map = null; }
                m.dispose();
            });
        }

        // 6. Nullify all references to assist GC
        tile.mesh = null;
        tile.flatMesh = null;
        tile.material = null;
        tile.clonedMaterials = null;
        tile.container = null;
        tile.lods = null;
        tile.hexDataLayers = null;
    }

    hideLoader() {
        if (this.loaderHidden) return;

        // Force a minimum "hero" moment for the loader so it doesn't just flash
        const elapsed = performance.now() - this.appStartTime;
        if (elapsed < 900) {
            setTimeout(() => this.hideLoader(), 900 - elapsed);
            return;
        }

        this.loaderHidden = true;
        console.log(`[HEXAGONS] ${APP_VERSION} — ready in ${(elapsed / 1000).toFixed(1)}s (${this.tiles.size} tiles)`);
        const loader = document.getElementById('loader');
        if (loader) {
            loader.classList.add('hide');
            // Clean up DOM after fade
            setTimeout(() => { loader.style.display = 'none'; }, 600);

            // Init Search Bar now that we are live
            this.searchBar = new HexSearch();
        }
    }

    maintainCameraAltitudeDuringAnimation(h) {
        const target = this.controls.target;
        const wx = target.x + this.worldOrigin.x;
        const wy = this.worldOrigin.y - target.z;

        const q_r = worldToSectorID(wx, wy);
        const key = `${q_r.Q}_${q_r.R}`;
        const tile = this.tiles.get(key);

        // Update Readouts
        const secEl = document.getElementById('sector-val');
        if (secEl) secEl.textContent = `${q_r.Q}, ${q_r.R}`;

        const worldEl = document.getElementById('world-val');
        if (worldEl) worldEl.textContent = `${wx.toFixed(0)}, ${wy.toFixed(0)}`;

        // Approximate Hex (Axial)
        const h_size = UNIT_HEX_WIDTH_METERS;
        const aq = Math.round(wx / (Math.sqrt(3) / 2 * h_size));
        const ar = Math.round((wy - (aq * 0.5 * h_size)) / h_size);

        const hexEl = document.getElementById('hex-val');
        if (hexEl) hexEl.textContent = `${aq}, ${ar}`;

        if (tile && tile.center) {
            // Find specific hex height
            const dq = aq - tile.center.q;
            const dr = ar - tile.center.r;

            let groundH = tile.stats.min; // Fallback
            let found = false;

            // Search Active Layers (start from finest L3 -> index 3)
            // Or just search all? Finest is best.
            for (let l = 3; l >= 0; l--) {
                const layer = tile.hexDataLayers[l];
                if (!layer) continue;
                // Simple linear search (fast enough for 1 hex per frame)
                for (const hx of layer) {
                    if (hx.dq === dq && hx.dr === dr) {
                        groundH = hx.h;
                        found = true;
                        break;
                    }
                }
                if (found) break;
            }

            // If not found (maybe gap?), fall back to average, not MAX.
            if (!found) groundH = tile.stats.avg;

            const animatedH = (groundH - this.floorState.value) * h;
            const minCamY = animatedH + 50.0;

            // Soft constraint: only push if below
            if (this.camera.position.y < minCamY) this.camera.position.y = minCamY;

            const thEl = document.getElementById('tile-height');
            if (thEl) thEl.textContent = `${animatedH.toFixed(1)}m`;
        }
        const chEl = document.getElementById('camera-height');
        if (chEl) chEl.textContent = `${this.camera.position.y.toFixed(0)}m`;
    }

    updateFloorState(h) {
        const currentMin = this.pickFloorValue();

        if (LOCK_FLOOR_ON_RISE && h > FLOOR_LOCK_THRESHOLD) {
            // Logic: Only update if we found a LOWER floor (prevent sinking), but don't raise it (prevent jitter).
            if (!this.floorState.locked || currentMin < this.floorState.value) {
                this.floorState.value = currentMin;
            }
            this.floorState.locked = true;
            this.updateFloorUniforms();
        } else if (!LOCK_FLOOR_ON_RISE) {
            this.floorState.value = currentMin;
            this.updateFloorUniforms();
        } else {
            // Not yet locked (flat mode), just track freely
            this.floorState.value = currentMin;
            this.updateFloorUniforms();
        }
    }

    pickFloorValue() {
        const inView = this.getTilesInView();
        const validTiles = inView.length ? inView : Array.from(this.tiles.values());
        let min = Infinity;
        for (const t of validTiles) if (t.stats && t.stats.min < min) min = t.stats.min;
        return Number.isFinite(min) ? min : 0;
    }

    getTilesInView() {
        this.camera.updateMatrixWorld();
        this.projScreenMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
        return Array.from(this.tiles.values()).filter(t => this.frustum.intersectsBox(t.bounds));
    }

    updateFloorUniforms() {
        for (const m of this.materialsToUpdate) {
            if (m.userData.shader) m.userData.shader.uniforms.uFloorOffset.value = this.floorState.value;
        }
    }

    resetLODs() {
        const preset = this.isMobile ? this.LOD_CONFIG.MOBILE.MOVING : this.LOD_CONFIG.DESKTOP.MOVING;
        // Reset if we deviate from "moving" preset or if we are in the middle of refinement
        if (this.lodRanges.unitEnd !== preset.unitEnd || this.isRefining) {
            this.lodRanges = { ...preset };
            this.isRefining = false;
            this.needsRender = true;
            this.syncLODUI();
        }
    }

    refineLODs() {
        // Stop if sustained framerate is tanking (use average of last 5 frames)
        const sampleCount = 5;
        const recentFrames = this.frametimeBuffer.slice(-sampleCount);
        const avgFrameTime = recentFrames.reduce((a, b) => a + b, 0) / recentFrames.length;

        if (avgFrameTime > this.maxFrameTime) {
            if (this.isRefining) {
                this.log(`Antisintering capped by performance (${avgFrameTime.toFixed(1)}ms avg)`, "warn");
                this.isRefining = false;
            }
            return false;
        }

        const target = this.isMobile ? this.LOD_CONFIG.MOBILE.TARGET : this.LOD_CONFIG.DESKTOP.TARGET;
        let changed = false;

        // Helper to nudge value
        const nudge = (current, goal) => {
            if (current < goal) {
                return Math.min(current + this.refineSpeed, goal);
            }
            return current;
        };

        const oldUnitEnd = this.lodRanges.unitEnd;
        const oldSmallEnd = this.lodRanges.smallEnd;
        const oldMedEnd = this.lodRanges.mediumEnd;

        this.lodRanges.unitEnd = nudge(this.lodRanges.unitEnd, target.unitEnd);

        // BACKGROUND POPULATION: Keep small hexes covering the foreground (0m start) 
        // until unit hexes have mostly populated.
        if (this.lodRanges.unitEnd >= target.unitEnd * 0.95) {
            this.lodRanges.smallStart = Math.max(0, this.lodRanges.unitEnd - 50);
        } else {
            this.lodRanges.smallStart = 0;
        }

        this.lodRanges.smallEnd = nudge(this.lodRanges.smallEnd, target.smallEnd);

        // Similar strategy for medium
        if (this.lodRanges.smallEnd >= target.smallEnd * 0.95) {
            this.lodRanges.mediumStart = Math.max(0, this.lodRanges.smallEnd - 50);
        } else {
            this.lodRanges.mediumStart = 0;
        }

        this.lodRanges.mediumEnd = nudge(this.lodRanges.mediumEnd, target.mediumEnd);

        if (this.lodRanges.mediumEnd >= target.mediumEnd * 0.95) {
            this.lodRanges.largeStart = Math.max(0, this.lodRanges.mediumEnd - 50);
        } else {
            this.lodRanges.largeStart = 0;
        }

        // Check for meaningful changes
        if (this.lodRanges.unitEnd !== oldUnitEnd ||
            this.lodRanges.smallEnd !== oldSmallEnd ||
            this.lodRanges.mediumEnd !== oldMedEnd) {
            changed = true;
        }

        // Check if we are fully done/reached targets
        const isDone = (this.lodRanges.unitEnd >= target.unitEnd &&
            this.lodRanges.smallEnd >= target.smallEnd &&
            this.lodRanges.mediumEnd >= target.mediumEnd);

        if (changed) {
            this.isRefining = true;
            this.needsRender = true; // Force a frame
            this.needsLODUpdate = true; // FORCE LOD check to recognize new ranges
            this.syncLODUI();
        } else if (isDone && this.isRefining) {
            this.log("Antisintering Complete: Maximum Resolution Reached.", "success");
            this.isRefining = false;
        }

        return !isDone;
    }

    // --- ENGINE STATE DERIVATION ---
    deriveEngineState(moved, flat) {
        // Priority order: MOVING_3D > MOVING_2D > SINTERING > STATIC
        if (this.isMoving3D) return ENGINE_STATES.MOVING_3D;
        if (moved || this.isUserInteracting) return flat ? ENGINE_STATES.MOVING_2D : ENGINE_STATES.MOVING_3D;
        const recentUpgrade = this.recentlyUpgradedTextures.some(u => performance.now() - u.time < 100);
        if (this.sinterQueue.length > 0 || this.upgradeQueue.length > 0 ||
            this.activeWorkerCount > 0 || this.isRefining || recentUpgrade) return ENGINE_STATES.SINTERING;
        return ENGINE_STATES.STATIC;
    }

    // --- PORCELAIN OUTPUT: Machine-readable stats API for Playwright / automation ---
    getDetailedStats(phase = 'snapshot') {
        // Compute spatial breakdown (The Radar)
        this.projScreenMatrix.multiplyMatrices(
            this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
        const spatial = this.vramLedger.getSpatialBreakdown(
            this.frustum, this.camera.position, this.tiles);

        const fmt = (b) => {
            if (b < 1024) return `${b} B`;
            if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
            if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
            return `${(b / 1073741824).toFixed(2)} GB`;
        };

        const _classVec = new THREE.Vector3();
        const renderDist = this.renderSettings.renderDistance;
        let visCount = 0, bufCount = 0, vesCount = 0;
        let visBytes = 0, bufBytes = 0, vesBytes = 0;
        let visFull = 0, visLow = 0, bufFull = 0, bufLow = 0, vesFull = 0, vesLow = 0;

        for (const [key, tile] of this.tiles) {
            const entry = this.vramLedger.entries.get(key);
            const bytes = entry ? (entry.geometryBytes + entry.textureBytes) : 0;
            const inFrustum = tile.bounds && this.frustum.intersectsBox(tile.bounds);
            const isFull = !!tile.isFullTex;

            if (inFrustum) {
                visCount++; visBytes += bytes;
                if (isFull) visFull++; else visLow++;
            } else {
                _classVec.set(entry?.lx || 0, 0, entry?.lz || 0);
                const dist = _classVec.distanceTo(this.camera.position);
                if (dist <= renderDist) {
                    bufCount++; bufBytes += bytes;
                    if (isFull) bufFull++; else bufLow++;
                } else {
                    vesCount++; vesBytes += bytes;
                    if (isFull) vesFull++; else vesLow++;
                }
            }
        }

        return {
            phase,
            timestamp: performance.now(),
            engineState: this.engineState,
            activeTileCount: this.tiles.size,
            tileClassification: {
                visible: { count: visCount, full: visFull, low: visLow, vram: fmt(visBytes), bytes: visBytes },
                buffer: { count: bufCount, full: bufFull, low: bufLow, vram: fmt(bufBytes), bytes: bufBytes },
                vestigial: { count: vesCount, full: vesFull, low: vesLow, vram: fmt(vesBytes), bytes: vesBytes },
            },
            vram: {
                geometryBytes: this.vramLedger.totalGeometryBytes,
                textureBytes: this.vramLedger.totalTextureBytes,
                totalBytes: this.vramLedger.totalVRAMBytes,
                budgetBytes: this.cacheManager.budget,
                budgetUtilization: +(this.cacheManager.utilization).toFixed(4),
                // Human-readable
                geometry: fmt(this.vramLedger.totalGeometryBytes),
                textures: fmt(this.vramLedger.totalTextureBytes),
                total: fmt(this.vramLedger.totalVRAMBytes),
                budget: fmt(this.cacheManager.budget),
                headroom: fmt(this.cacheManager.headroom),
            },
            network: {
                totalPayloadBytes: this.vramLedger.totalNetworkBytes,
                binBytes: this.vramLedger._networkBin,
                texBytes: this.vramLedger._networkTex,
                // Human-readable
                total: fmt(this.vramLedger.totalNetworkBytes),
                bin: fmt(this.vramLedger._networkBin),
                tex: fmt(this.vramLedger._networkTex),
            },
            spatial: {
                inFrustumBytes: spatial.inFrustumBytes,
                outFrustumBytes: spatial.outFrustumBytes,
                nearBytes: spatial.nearBytes,
                midBytes: spatial.midBytes,
                farBytes: spatial.farBytes,
                inFrustumTiles: spatial.tileBreakdown.inFrustum,
                outFrustumTiles: spatial.tileBreakdown.outFrustum,
                // Human-readable
                inFrustum: `${spatial.tileBreakdown.inFrustum} tiles (${fmt(spatial.inFrustumBytes)})`,
                outFrustum: `${spatial.tileBreakdown.outFrustum} tiles (${fmt(spatial.outFrustumBytes)})`,
                near: fmt(spatial.nearBytes),
                mid: fmt(spatial.midBytes),
                far: fmt(spatial.farBytes),
            },
            tiles: {
                loaded: this.tiles.size,
                loadQueue: this.loadQueue.length,
                upgradeQueue: this.upgradeQueue.length,
                sinterQueue: this.sinterQueue.length,
                activeWorkers: this.activeWorkerCount,
                materialsTracked: this.materialsToUpdate.size,
                evictedTotal: this.cacheManager.evictionCount,
                evictedBytes: fmt(this.cacheManager.evictedBytes),
                redownloads: this.cacheManager.redownloadCount,
            },
            violations: this._perfViolationCount,
            allocationCount: this.vramLedger.entries.size,
        };
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this._frameCounter++;

        // --- BACKGROUND MAINTENANCE ---
        track('processInstantiationQueue', () => this.processInstantiationQueue());
        track('processQueues', () => this.processQueues());

        const now = performance.now();
        const timeSinceInteraction = now - this.lastInteractionTime;

        // --- ANTISINTERING REFINEMENT ---
        if (!this.isUserInteracting && timeSinceInteraction > 200) {
            if (!this.isRefining && !this.isRefinementDone) {
                this.isRefining = true;
            }
            const stillRefining = track('refineLODs', () => this.refineLODs());
            if (!stillRefining) this.isRefinementDone = true;
        } else {
            if (this.isUserInteracting) {
                this.isRefinementDone = false;
            }
        }

        // Disable damping when not actively interacting to prevent momentum in sintered mode.
        this.controls.enableDamping = this.isUserInteracting;
        const moved = this.controls.update();

        // CALCULATE isMoving3D EARLY so updateLOD() can skip texture upgrades during movement
        const angle = this.controls.getPolarAngle() * 180 / Math.PI;
        const flat = angle < 5.5;
        const wasMoving3D = this.isMoving3D;
        this.isMoving3D = !flat && (moved || this.isUserInteracting);

        // --- DERIVE ENGINE STATE (must happen after moved/flat/isMoving3D are set) ---
        this.engineState = this.deriveEngineState(moved, flat);

        // If transitioning INTO movement, clear the upgrade queue
        if (!wasMoving3D && this.isMoving3D) {
            this.upgradeQueue.length = 0;
            for (const tile of this.tiles.values()) {
                tile.queuedForUpgrade = false;
            }
        }

        // NOW update LOD (after isMoving3D is set)
        const camDist = this.camera.position.distanceTo(this.lastLODCamPos);
        if (camDist > 50 || this.isRefining || this.needsLODUpdate || !this.loaderHidden) {
            track('updateLOD', () => this.updateLOD());
            if (camDist > 50) this.lastLODCamPos.copy(this.camera.position);
            this.needsLODUpdate = false;
        }

        // --- RENDER CHECK ---
        // STATIC state: must NOT render. Early-out if nothing moved and no flags set.
        if (!moved && !this.needsRender) return;

        // ===== BEGIN TIMED RENDER CYCLE =====
        const cycleStart = performance.now();

        this.updateRenderStats(now);
        this.updateFps();
        this.updateFrametimeGraph();

        const linear = Math.min(1, Math.max(0, (angle - 5.5) / (25.0 - 5.5)));
        const h = linear;

        if (this.isMoving3D) {
            this.lastInteractionTime = now;
            this.isRefining = false;
            this.resetLODs();
            this.needsLODUpdate = true;
            this.lodTransitionInProgress = false;
            this.lastLodPreset = 'MOVING';
        } else if (wasMoving3D && !flat) {
            const target = this.isMobile ? this.LOD_CONFIG.MOBILE.TARGET : this.LOD_CONFIG.DESKTOP.TARGET;
            this.lodRanges = { ...target };
            this.needsLODUpdate = true;
            this.syncLODUI();
            this.lodTransitionInProgress = true;
            this.lastLodPreset = 'TARGET';
        }

        this.updateFloorState(h);
        this.maintainCameraAltitudeDuringAnimation(h);

        // --- VISIBILITY PASS ---
        let visibilityChanges = 0;
        for (const t of this.tiles.values()) {
            if (flat) {
                if (t.flatMesh && !t.flatMesh.visible) { t.flatMesh.visible = true; visibilityChanges++; }
                if (t.mesh && t.mesh.visible) { t.mesh.visible = false; visibilityChanges++; }
            } else {
                if (t.flatMesh && t.flatMesh.visible) { t.flatMesh.visible = false; visibilityChanges++; }
                if (t.mesh) {
                    if (!t.mesh.visible) { t.mesh.visible = true; visibilityChanges++; }
                    t.mesh.children.forEach(meshGroup => {
                        const m = meshGroup.children[0]?.material;
                        if (m && m.userData.lodIdx !== undefined) {
                            const idx = m.userData.lodIdx;
                            let active = false;
                            if (idx === 3) active = (this.lodRanges.unitEnd > 0);
                            else if (idx === 2) active = (this.lodRanges.smallEnd > 0);
                            else if (idx === 1) active = (this.lodRanges.mediumEnd > 0);
                            else if (idx === 0) active = true;
                            if (meshGroup.visible !== active) { meshGroup.visible = active; visibilityChanges++; }
                        }
                    });
                }
            }
        }

        // --- SINTERING (settled 3D) ---
        if (!flat && !this.isMoving3D) {
            const inView = this.getTilesInView();
            for (const t of inView) {
                if (t.needsSinteredBuild && !this.sinterQueue.includes(t)) {
                    this.sinterQueue.push(t);
                }
            }
            if (this.sinterQueue.length > 0) {
                const tile = this.sinterQueue.shift();
                this.buildSinteredLods(tile);
            }
        }
        this.wasMoving3D = this.isMoving3D;

        // --- MATERIAL UNIFORM UPDATE ---
        let needsUpdateCount = 0;
        for (const m of this.materialsToUpdate) {
            if (m.needsUpdate) needsUpdateCount++;
            if (m.userData.shader) {
                m.userData.shader.uniforms.uHeightFactor.value = h;
                m.userData.shader.uniforms.uGradientMode.value = this.gradientMode;
                if (!m.userData.shader.uniforms.uCameraPos) {
                    m.userData.shader.uniforms.uCameraPos = { value: new THREE.Vector3() };
                }
                const uCam = m.userData.shader.uniforms.uCameraPos;
                if (!uCam.value || !uCam.value.copy) {
                    uCam.value = new THREE.Vector3();
                }
                uCam.value.copy(this.camera.position);

                if (m.userData.lodIdx !== undefined) {
                    const idx = m.userData.lodIdx;
                    let minD = 0.0, maxD = 100000.0;

                    if (idx === -1) { minD = 0.0; maxD = 100000.0; }
                    else if (idx === 3) { minD = 0.0; maxD = this.lodRanges.unitEnd; }
                    else if (idx === 2) { minD = this.lodRanges.smallStart; maxD = this.lodRanges.smallEnd; }
                    else if (idx === 1) { minD = this.lodRanges.mediumStart; maxD = this.lodRanges.mediumEnd; }
                    else if (idx === 0) { minD = this.lodRanges.largeStart; maxD = this.renderSettings.renderDistance + 500.0; }

                    if (!m.userData.shader.uniforms.uLodRadii || !m.userData.shader.uniforms.uLodRadii.value || !m.userData.shader.uniforms.uLodRadii.value.set) {
                        m.userData.shader.uniforms.uLodRadii = { value: new THREE.Vector2(0, 100000.0) };
                    }
                    m.userData.shader.uniforms.uLodRadii.value.set(minD, maxD);
                }
            }
        }

        // --- RENDER ---
        this.renderer.render(this.scene, this.camera);

        // ===== END TIMED RENDER CYCLE =====
        const cycleDuration = performance.now() - cycleStart;
        const budget = STATE_BUDGETS_MS[this.engineState];

        // --- STRUCTURED VIOLATION LOGGING ---
        if (cycleDuration > budget) {
            this._perfViolationCount++;

            if (this._perfViolationCount <= PERF_VERBOSE_MAX) {
                // VERBOSE: Full-fat output for first N violations
                const culprits = [];
                if (visibilityChanges > 50) culprits.push(`vis-thrash:${visibilityChanges}`);
                if (needsUpdateCount > 0) culprits.push(`mat-recompile:${needsUpdateCount}`);
                const recentUpgrades = this.recentlyUpgradedTextures.filter(u => now - u.time < 50);
                if (recentUpgrades.length > 0) culprits.push(`tex-upgrade:${recentUpgrades.length}`);
                this.recentlyUpgradedTextures = recentUpgrades.slice(-3);
                if (this.sinterQueue.length > 0) culprits.push(`sinter-queue:${this.sinterQueue.length}`);
                if (this.lodTransitionInProgress) culprits.push('lod-transition');
                if (culprits.length === 0) culprits.push('gpu-render');

                console.log('[PERF_VIOLATION] ' + JSON.stringify({
                    state: this.engineState,
                    duration: +cycleDuration.toFixed(1),
                    budget,
                    culprits,
                    frame: this._frameCounter
                }));
            } else {
                // STATISTICAL: Accumulate silently, flush every PERF_STATS_WINDOW violations
                const st = this.engineState;
                if (!this._perfStats[st]) this._perfStats[st] = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
                const s = this._perfStats[st];
                s.min = Math.min(s.min, cycleDuration);
                s.max = Math.max(s.max, cycleDuration);
                s.sum += cycleDuration;
                s.count++;

                const accumulated = Object.values(this._perfStats).reduce((a, b) => a + b.count, 0);
                if (accumulated >= PERF_STATS_WINDOW) {
                    const summary = {};
                    for (const [state, data] of Object.entries(this._perfStats)) {
                        summary[state] = {
                            count: data.count,
                            avg: +(data.sum / data.count).toFixed(1),
                            min: +data.min.toFixed(1),
                            max: +data.max.toFixed(1)
                        };
                    }
                    console.log('[PERF_VIOLATION] ' + JSON.stringify({
                        type: 'stats',
                        totalViolations: this._perfViolationCount,
                        window: PERF_STATS_WINDOW,
                        summary,
                        frame: this._frameCounter
                    }));
                    // Reset accumulators for next window
                    this._perfStats = {};
                }
            }
        }

        // Consume transition flag (allow one frame grace)
        if (this.lodTransitionInProgress) this.lodTransitionInProgress = false;

        this.needsRender = false;
        this.floorState.lastFactor = h;
    }
}

new PistonViewer();


# ================================================================================
# FILE 7/13
# Path: frontend/app/search.js
# ================================================================================

// @atlas: The 'HexSearch' module. A UI component that lazy-loads GeoJSON data for Tirol peaks and ski resorts, providing an interactive search interface. It translates geographic coordinates to local PistonViewer space and safely rejects flights to destinations lying outside the currently baked map bounds.
import { initProjection, latLonToWorld } from './coordinate_utility.js';

export class HexSearch {
    constructor() {
        this.peaks = [];
        this.skiAreas = [];
        this.loaded = false;
        this.activeIndex = 0;
        this.currentResults = []; // [{type, item}, ...]

        this.injectStyles();
        this.initUI();
    }

    injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #hex-search-container {
                position: absolute;
                top: 20px;
                right: 20px;
                width: 300px;
                z-index: 1000;
                font-family: 'Outfit', sans-serif;
            }
            .search-box {
                background: rgba(15, 23, 42, 0.8);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(116, 185, 255, 0.2);
                border-radius: 24px;
                display: flex;
                align-items: center;
                padding: 10px 15px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                transition: all 0.3s ease;
            }
            .search-box:focus-within {
                border-color: #ff6b9d;
                box-shadow: 0 10px 40px rgba(255, 107, 157, 0.2);
            }
            .search-box svg {
                color: #74b9ff;
                margin-right: 10px;
            }
            #hex-search-input {
                background: transparent;
                border: none;
                color: #fff;
                font-family: inherit;
                font-size: 1rem;
                width: 100%;
                outline: none;
            }
            #hex-search-results {
                margin-top: 10px;
                background: rgba(15, 23, 42, 0.9);
                backdrop-filter: blur(16px);
                border-radius: 12px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                max-height: 400px;
                overflow-y: auto;
                opacity: 0;
                transform: translateY(-10px);
                pointer-events: none;
                transition: all 0.2s ease;
            }
            #hex-search-results.visible {
                opacity: 1;
                transform: translateY(0);
                pointer-events: auto;
            }
            .result-section {
                padding: 8px 15px;
                font-size: 0.7rem;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 1px;
                color: #94a3b8;
                border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            }
            .result-item {
                padding: 12px 15px;
                cursor: pointer;
                transition: background 0.1s;
                border-left: 2px solid transparent;
            }
            .result-item:hover, .result-item.active {
                background: rgba(116, 185, 255, 0.1);
                border-left-color: #74b9ff;
            }
            .result-item .name {
                display: block;
                color: #e2e8f0;
                font-weight: 600;
            }
            .result-item .meta {
                display: block;
                font-size: 0.8rem;
                color: #64748b;
                margin-top: 2px;
            }
            .result-item.ski {
                border-left-color: #ff6b9d; /* Pink for Ski */
            }
            
            @media (max-width: 768px) {
                #hex-search-container {
                    top: 10px;
                    right: 10px;
                    width: calc(100% - 20px);
                }
            }
        `;
        document.head.appendChild(style);
    }

    initUI() {
        const container = document.createElement('div');
        container.id = 'hex-search-container';
        container.innerHTML = `
            <div class="search-box">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                <input type="text" id="hex-search-input" placeholder="Search Peaks & Ski Areas..." autocomplete="off">
            </div>
            <div id="hex-search-results" class="hidden"></div>
        `;
        document.body.appendChild(container);

        this.input = document.getElementById('hex-search-input');
        this.resultsBox = document.getElementById('hex-search-results');

        this.input.addEventListener('focus', () => this.loadData());
        this.input.addEventListener('input', (e) => this.handleInput(e));
        this.input.addEventListener('keydown', (e) => this.handleKey(e));

        // Hide on click outside
        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) {
                this.resultsBox.classList.remove('visible');
            }
        });
    }

    async loadData() {
        if (this.loaded) return;

        try {
            // Lazy load projection + data
            await initProjection();

            const [peaksRes, skiRes] = await Promise.all([
                fetch('assets/tirol_peaks.geojson'),
                fetch('assets/skigebiete.json')
            ]);

            const peaksData = await peaksRes.json();
            const skiData = await skiRes.json();

            this.peaks = peaksData.features.map(f => ({
                name: f.properties.name,
                ele: f.properties.ele,
                lat: f.geometry.coordinates[1],
                lon: f.geometry.coordinates[0],
                type: 'peak'
            })).filter(p => p.name);

            this.skiAreas = skiData.ski_areas.map(a => ({
                name: a.name,
                lat: a.gps.lat,
                lon: a.gps.lon,
                type: 'ski'
            }));

            this.loaded = true;
            console.log(`Loaded ${this.peaks.length} peaks and ${this.skiAreas.length} ski areas.`);

        } catch (e) {
            console.error("Search Data Load Error:", e);
        }
    }

    handleInput(e) {
        const query = e.target.value.toLowerCase().trim();
        if (query.length < 2) {
            this.resultsBox.classList.remove('visible');
            return;
        }

        const skiMatches = this.skiAreas
            .filter(i => i.name.toLowerCase().includes(query))
            .slice(0, 5)
            .map(i => ({ ...i, category: 'Ski Areas' }));

        const peakMatches = this.peaks
            .filter(i => i.name.toLowerCase().includes(query))
            .slice(0, 10)
            .map(i => ({ ...i, category: 'Peaks' }));

        this.currentResults = [...skiMatches, ...peakMatches];
        this.activeIndex = 0;
        this.renderResults();
    }

    renderResults() {
        if (this.currentResults.length === 0) {
            this.resultsBox.innerHTML = `<div class="result-item"><span class="meta">No matches found.</span></div>`;
            this.resultsBox.classList.add('visible');
            return;
        }

        let html = '';
        let lastCat = '';

        this.currentResults.forEach((res, idx) => {
            if (res.category !== lastCat) {
                html += `<div class="result-section">${res.category}</div>`;
                lastCat = res.category;
            }

            const activeClass = (idx === this.activeIndex) ? 'active' : '';

            // Geographic Bounds Check
            let isOutside = false;
            let statusLabel = '';
            if (window.pistonViewer && window.pistonViewer.manifest && window.pistonViewer.manifest.bounds) {
                const worldPos = latLonToWorld(res.lat, res.lon);
                const b = window.pistonViewer.manifest.bounds;
                if (worldPos.x < b.min_x || worldPos.x > b.max_x || worldPos.y < b.min_y || worldPos.y > b.max_y) {
                    isOutside = true;
                    statusLabel = ' <span style="color: #ff4757; font-size: 0.7rem; font-weight: 800;">[OUTSIDE MAP]</span>';
                }
            }

            const meta = res.type === 'peak' ? `${res.ele}m • Peak` : 'Ski Resort';

            html += `
                <div class="result-item ${res.type} ${activeClass} ${isOutside ? 'outside' : ''}" data-idx="${idx}" ${isOutside ? 'style="opacity: 0.5;"' : ''}>
                    <span class="name">${res.name}${statusLabel}</span>
                    <span class="meta">${meta}</span>
                </div>
            `;
        });

        this.resultsBox.innerHTML = html;
        this.resultsBox.classList.add('visible');

        // Add click listeners
        document.querySelectorAll('.result-item').forEach(el => {
            el.addEventListener('click', () => {
                this.selectResult(parseInt(el.dataset.idx));
            });
        });
    }

    handleKey(e) {
        if (!this.resultsBox.classList.contains('visible')) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.activeIndex = (this.activeIndex + 1) % this.currentResults.length;
            this.renderResults();
            this.scrollToActive();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.activeIndex = (this.activeIndex - 1 + this.currentResults.length) % this.currentResults.length;
            this.renderResults();
            this.scrollToActive();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            this.selectResult(this.activeIndex);
        } else if (e.key === 'Escape') {
            this.resultsBox.classList.remove('visible');
            this.input.blur();
        }
    }

    scrollToActive() {
        const el = this.resultsBox.querySelector('.result-item.active');
        if (el) el.scrollIntoView({ block: 'nearest' });
    }

    selectResult(idx) {
        if (!this.currentResults[idx]) return;

        const item = this.currentResults[idx];
        const worldPos = latLonToWorld(item.lat, item.lon);

        // Final Bounds Check Before Flight
        if (window.pistonViewer && window.pistonViewer.manifest && window.pistonViewer.manifest.bounds) {
            const b = window.pistonViewer.manifest.bounds;
            if (worldPos.x < b.min_x || worldPos.x > b.max_x || worldPos.y < b.min_y || worldPos.y > b.max_y) {
                console.log(`Blocked navigation to ${item.name} - Outside map bounds.`);
                if (window.pistonViewer.log) window.pistonViewer.log(`"${item.name}" is outside the current map area.`, "info");
                return;
            }
        }

        console.log(`Zooming to ${item.name}:`, worldPos);

        if (window.pistonViewer) {
            // Adjust camera logic for PistonViewer
            // PistonViewer origin is 0,0,0 at init start.
            // We need to map worldPos to ONE PistonViewer local coord.
            // main.js: this.worldOrigin = { x: min_x, y: min_y };
            // localX = worldPos.x - worldOrigin.x
            // localZ = -(worldPos.y - worldOrigin.y)

            const v = window.pistonViewer;
            if (v.worldOrigin) {
                const tx = worldPos.x - v.worldOrigin.x;
                const tz = -(worldPos.y - v.worldOrigin.y);

                // Fly there
                v.controls.target.set(tx, 0, tz);
                v.camera.position.set(tx, 1500, tz + 1000); // Offset for view
                v.controls.update();
                v.needsRender = true;
                v.needsLODUpdate = true;

                // Trigger detail load if far
                v.renderSettings.renderDistance = v.renderSettings.renderDistance || 4000;
                v.updateLOD();
            }
        }

        this.resultsBox.classList.remove('visible');
        this.input.value = item.name;
    }
}

// End of Search Module


# ================================================================================
# FILE 8/13
# Path: frontend/app/style.css
# ================================================================================

/* @atlas: The central stylesheet for the 'Bestagon' Viewer application. Uses raw CSS to implement a modern, glassmorphic visual identity featuring translucent HUD panels, custom WebKit scrollbars, dynamic SVG animation keyframes, and responsive media queries for the performance telemetry overlay. */
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    background-color: #050505;
    color: #fff;
    font-family: 'Outfit', sans-serif;
    overflow: hidden;
}

#canvas-container {
    position: absolute;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
}

#ui {
    position: absolute;
    top: 20px;
    left: 20px;
    z-index: 10;
    pointer-events: none;
}

.glass-panel {
    background: rgba(20, 20, 20, 0.7);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 20px;
    border-radius: 12px;
    pointer-events: auto;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

/* === DEBUG: Panel minimize functionality === */
.panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 15px;
}

.header-content {
    flex: 1;
}

.minimize-btn {
    background: rgba(116, 185, 255, 0.2);
    border: 1px solid rgba(116, 185, 255, 0.4);
    color: #fff;
    font-size: 1.2rem;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
    font-family: monospace;
    line-height: 1;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}

.minimize-btn:hover {
    background: rgba(116, 185, 255, 0.4);
}

.minimize-btn:active {
    transform: translateY(1px);
}

#main-panel.minimized .panel-body {
    display: none;
}

#main-panel.minimized .panel-header {
    margin-bottom: 0;
}

.panel-body {
    max-height: 70vh;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 5px;
}

.panel-body::-webkit-scrollbar {
    width: 6px;
}

.panel-body::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 3px;
}

.panel-body::-webkit-scrollbar-thumb {
    background: rgba(116, 185, 255, 0.3);
    border-radius: 3px;
}

.panel-body::-webkit-scrollbar-thumb:hover {
    background: rgba(116, 185, 255, 0.5);
}

/* Collapsible Sections */
.collapsible-section {
    margin-top: 15px;
    border-top: 1px solid #333;
    padding-top: 10px;
}

.collapsible-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    user-select: none;
    padding: 8px 0;
    transition: all 0.2s;
}

.collapsible-header:hover {
    color: #74b9ff;
}

.collapsible-header .title {
    font-weight: bold;
    color: #fff;
    font-size: 0.9rem;
}

.collapsible-header .arrow {
    transition: transform 0.2s;
    color: #74b9ff;
    font-size: 0.8rem;
}

.collapsible-section.collapsed .arrow {
    transform: rotate(-90deg);
}

.collapsible-content {
    max-height: 500px;
    overflow: hidden;
    transition: max-height 0.3s ease-out, opacity 0.2s;
    opacity: 1;
}

.collapsible-section.collapsed .collapsible-content {
    max-height: 0;
    opacity: 0;
}

/* === END DEBUG === */

h1 {
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.5px;
    background: linear-gradient(45deg, #ff6b9d, #74b9ff);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 5px;
}

.subtitle {
    font-size: 0.8rem;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.stats {
    margin-top: 15px;
    font-size: 0.9rem;
    color: #ccc;
}

.hud-item {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 5px;
    align-items: center;
}

.value {
    color: #74b9ff;
    font-family: monospace;
}

/* === DEBUG: Frametime graph === */
.frametime-item {
    flex-direction: column;
    align-items: stretch;
}

#frametime-graph {
    width: 100%;
    border: 1px solid rgba(116, 185, 255, 0.3);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.5);
}

/* Resolution Slider Styling */
input[type="range"] {
    -webkit-appearance: none;
    width: 100%;
    height: 4px;
    background: rgba(116, 185, 255, 0.15);
    border-radius: 2px;
    outline: none;
    margin: 10px 0;
}

input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    background: #74b9ff;
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 0 12px rgba(116, 185, 255, 0.6);
    border: 2px solid #fff;
    transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

input[type="range"]::-webkit-slider-thumb:hover {
    transform: scale(1.2);
    background: #fff;
}

input[type="range"]::-moz-range-thumb {
    width: 16px;
    height: 16px;
    background: #74b9ff;
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 0 12px rgba(116, 185, 255, 0.6);
    border: 2px solid #fff;
}

/* === END DEBUG === */


.legend {
    position: absolute;
    bottom: 20px;
    right: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.legend-item {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.75rem;
    color: #999;
}

.swatch {
    width: 12px;
    height: 12px;
    border-radius: 2px;
}

/* Loading Screen */
#loader {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: #000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 100;
    transition: opacity 0.5s ease;
}

#loader.hide {
    opacity: 0;
    pointer-events: none;
}

/* Hexagon background pattern */
.hex-pattern {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-image:
        repeating-linear-gradient(0deg, transparent, transparent 60px, rgba(255, 107, 157, 0.03) 60px, rgba(255, 107, 157, 0.03) 62px),
        repeating-linear-gradient(60deg, transparent, transparent 60px, rgba(116, 185, 255, 0.03) 60px, rgba(116, 185, 255, 0.03) 62px),
        repeating-linear-gradient(120deg, transparent, transparent 60px, rgba(255, 107, 157, 0.03) 60px, rgba(255, 107, 157, 0.03) 62px);
    opacity: 0.5;
    animation: hexPulse 4s ease-in-out infinite;
}

@keyframes hexPulse {

    0%,
    100% {
        opacity: 0.3;
    }

    50% {
        opacity: 0.6;
    }
}

/* Skier animation */
.skier-container {
    position: relative;
    animation: skierZoom 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    transform: translateX(-200px);
    margin-bottom: 40px;
    overflow: visible;
}

@keyframes skierZoom {
    0% {
        transform: translateX(-200px) scale(0.8);
        opacity: 0;
    }

    60% {
        transform: translateX(20px) scale(1.1);
    }

    100% {
        transform: translateX(0) scale(1);
        opacity: 1;
    }
}

/* Speed lines behind skier */
.speed-lines {
    position: absolute;
    left: -60px;
    top: 50%;
    transform: translateY(-50%);
    width: 60px;
    height: 30px;
    pointer-events: none;
    z-index: -1;
}

.speed-lines .line {
    position: absolute;
    height: 2px;
    width: 60px;
    background: linear-gradient(90deg, transparent, #ff6b9d, transparent);
    animation: speedLine 0.8s ease-out infinite;
    transform-origin: right center;
    will-change: transform, opacity;
}

.speed-lines .line:nth-child(1) {
    top: 5px;
    animation-delay: 0s;
}

.speed-lines .line:nth-child(2) {
    top: 15px;
    animation-delay: 0.2s;
}

.speed-lines .line:nth-child(3) {
    top: 25px;
    animation-delay: 0.4s;
}

@keyframes speedLine {
    0% {
        transform: translateX(60px) scaleX(0);
        opacity: 1;
    }

    100% {
        transform: translateX(0) scaleX(1);
        opacity: 0;
    }
}

/* Loading text */
.loading-text {
    text-align: center;
    position: relative;
}

.main-message {
    font-size: 2.5rem;
    font-weight: 700;
    letter-spacing: -1px;
    background: linear-gradient(45deg, #ff6b9d, #74b9ff);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 20px;
    animation: textFadeIn 0.4s ease-out 0.4s forwards;
    opacity: 0;
}

@keyframes textFadeIn {
    to {
        opacity: 1;
    }
}

.fetching-message {
    font-size: 1.2rem;
    font-weight: 400;
    color: #74b9ff;
    letter-spacing: 0.5px;
    animation: flash 1s ease-in-out 0.8s infinite;
    opacity: 0;
}

@keyframes flash {

    0%,
    100% {
        opacity: 0;
    }

    10%,
    90% {
        opacity: 1;
    }

    50% {
        opacity: 0.6;
    }
}


.info-panel {
    margin-top: 15px;
    max-width: 320px;
}

.tech-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.7rem;
    color: #ff6b9d;
    font-weight: 700;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 2px;
}

.tech-description {
    font-size: 0.8rem;
    line-height: 1.5;
    color: #aaa;
}

.tech-spec {
    display: block;
    margin-top: 8px;
    padding-left: 10px;
    border-left: 2px solid #74b9ff;
    font-family: monospace;
    font-size: 0.75rem;
    color: #eee;
}

/* Debug Console */
.console-panel {
    margin-top: 20px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    padding-top: 15px;
}

.console-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    font-size: 0.75rem;
    color: #74b9ff;
    font-weight: 700;
    letter-spacing: 1px;
}

.console-btn {
    background: rgba(116, 185, 255, 0.2);
    border: 1px solid rgba(116, 185, 255, 0.4);
    color: #fff;
    font-size: 0.65rem;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    text-transform: uppercase;
    transition: all 0.2s;
    font-family: inherit;
}

.console-btn:hover {
    background: rgba(116, 185, 255, 0.4);
}

.console-btn:active {
    transform: translateY(1px);
}

.console-box {
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    height: 180px;
    overflow-y: auto;
    padding: 8px;
    font-family: 'Courier New', monospace;
    font-size: 0.65rem;
    color: #ccc;
    scrollbar-width: thin;
    scrollbar-color: #555 transparent;
    display: flex;
    flex-direction: column-reverse;
    /* Keep newest at bottom if we prepend, or just standard */
}

/* Actually standard direction is better for logs usually, auto-scroll */
.console-box {
    display: block;
}

.console-box::-webkit-scrollbar {
    width: 4px;
}

.console-box::-webkit-scrollbar-track {
    background: transparent;
}

.console-box::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 2px;
}

.log-line {
    margin-bottom: 3px;
    line-height: 1.3;
    word-wrap: break-word;
}

.log-time {
    color: #666;
    margin-right: 6px;
}

.log-line.warn {
    color: #f39c12;
}

.log-line.error {
    color: #e74c3c;
}

/* CSS 2.5D Map Layer */
#css-map-layer {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background-color: #050505;
    /* Match bg */
    z-index: 0;
    /* Behind UI (10) but ? */
    perspective: 800px;
    /* Aligns roughly with FOV 60 */
    pointer-events: none;
    /* Let clicks pass to canvas/controls */
}

#css-world {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 0;
    height: 0;
    transform-style: preserve-3d;
    backface-visibility: hidden;
    will-change: transform;
}

.css-tile {
    position: absolute;
    background-size: cover;
    backface-visibility: hidden;
    image-rendering: pixelated;
    /* speed? or crispness */
    opacity: 1;
    transition: opacity 0.5s ease;
    /* transform-origin: top left; is default? we center it. */
}

.log-line.success {
    color: #2ecc71;
}

.log-line.info {
    color: #3498db;
}



# ================================================================================
# FILE 9/13
# Path: frontend/app/tile_worker.js
# ================================================================================

// @atlas: Asynchronous background Web Worker dedicated to parsing 'HEX4' binary tiles. It handles network fetching, decodes the 16-byte packed structs (heights, slopes, deltas, packed normals), constructs Float32Array mesh buffers for instanced rendering, and passes them back via zero-copy transferables.
const SECTOR_WIDTH_METERS = 819.2;
const UNIT_HEX_PX = 32.0;
const METERS_PER_PIXEL = 0.2;
const UNIT_HEX_WIDTH_METERS = UNIT_HEX_PX * METERS_PER_PIXEL; // 6.4

// Helper: Axial conversion for parsing
function worldToAxialScale(x, y, s) {
    const h = UNIT_HEX_WIDTH_METERS * s;
    const A = (Math.sqrt(3) / 2) * h;
    const q = x / A;
    const r = (y - (q * 0.5 * h)) / h;
    return { q, r };
}

self.onmessage = async function (e) {
    const { id, type, data } = e.data;

    try {
        if (type === 'LOAD_TILE') {
            const result = await loadTile(data);
            // Transfer buffers to avoid copy
            const transferables = [];

            // Collect buffers from all LODs
            Object.values(result.lods).forEach(lod => {
                if (lod) {
                    transferables.push(lod.matrix.buffer);
                    transferables.push(lod.nz1.buffer);
                    transferables.push(lod.nz2.buffer);
                    transferables.push(lod.slopes.buffer);
                    transferables.push(lod.deltas.buffer);
                    transferables.push(lod.norms.buffer);
                }
            });

            // Transfer texture bitmap if it exists
            if (result.texture) {
                transferables.push(result.texture);
            }

            self.postMessage({ id, status: 'success', result }, transferables);

        } else if (type === 'LOAD_TEXTURE') {
            const result = await loadTextureOnly(data);
            self.postMessage({ id, status: 'success', result }, [result.bitmap]);
        }
    } catch (err) {
        // Error communicated to main thread via postMessage — no console spam
        self.postMessage({ id, status: 'error', error: err.message });
    }
};

async function loadTile({ q, r, lx, lz, texUrl, binUrl }) {
    // Parallel Fetch: Bin + LowTexture
    const [binRes, texRes] = await Promise.all([
        fetch(binUrl),
        fetch(texUrl)
    ]);

    if (!binRes.ok) throw new Error(`Failed to load bin: ${binUrl}`);
    const binBuf = await binRes.arrayBuffer();

    let texture = null;
    if (texRes.ok) {
        const blob = await texRes.blob();
        texture = await createImageBitmap(blob, { colorSpaceConversion: 'default', imageOrientation: 'flipY' });
    }

    // Parse & Generate Buffers
    const parsed = parseBinaryV3(binBuf);
    const lods = {};

    // Generate buffers for all 4 levels (0=Large .. 3=Unit)
    [0, 1, 2, 3].forEach(level => {
        lods[level] = generateMeshBuffers(parsed.layers, level, parsed.sx, parsed.sy);
    });

    return {
        lods,
        texture,
        stats: parsed.stats,
        center: parsed.center,
        layers: parsed.layers // Return raw data too for height picking if needed? 
        // Main thread needs raw layers for camera height collision
    };
}

async function loadTextureOnly({ url }) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load tex: ${url}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'default', imageOrientation: 'flipY' });
    return { bitmap };
}

function parseBinaryV3(buffer) {
    const view = new DataView(buffer);
    const sig = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (sig !== 'HEX4') throw new Error("Invalid Sig");

    const sx = view.getInt32(4, true);
    const sy = view.getInt32(8, true);
    const minZ = view.getFloat32(12, true);
    const maxZ = view.getFloat32(16, true);
    const scale = view.getFloat32(20, true);

    let offset = 32;
    const layers = [];
    const scales = [24.0, 6.0, 3.0, 1.0];

    const minX = sx * SECTOR_WIDTH_METERS;
    const minY = sy * SECTOR_WIDTH_METERS;
    const cenX = minX + SECTOR_WIDTH_METERS * 0.5;
    const cenY = minY + SECTOR_WIDTH_METERS * 0.5;

    for (let l = 0; l < 4; l++) {
        const count = view.getUint32(offset, true);
        offset += 4;
        const layer = [];
        const sc = scales[l];
        const rawC = worldToAxialScale(cenX, cenY, sc);
        const lcq = Math.round(rawC.q);
        const lcr = Math.round(rawC.r);

        for (let i = 0; i < count; i++) {
            const dq = view.getInt8(offset);
            const dr = view.getInt8(offset + 1);
            const hn = view.getUint16(offset + 2, true);
            const d1 = view.getInt16(offset + 4, true);
            const d2 = view.getInt16(offset + 6, true);
            const d3 = view.getInt16(offset + 8, true);
            const s1 = view.getUint8(offset + 10);
            const s2 = view.getUint8(offset + 11);
            const s3 = view.getUint8(offset + 12);
            const nx = view.getUint8(offset + 13);
            const nz = view.getUint8(offset + 14);
            offset += 16;

            layer.push({
                dq, dr,
                q: lcq + dq, r: lcr + dr,
                h: minZ + (hn / scale),
                deltas: [d1, d2, d3],
                slopes: [s1, s2, s3], // Array of 3
                norm: [nx, nz]
            });
        }
        layers.push(layer);
    }

    return { layers, sx, sy, stats: { min: minZ, max: maxZ, avg: (minZ + maxZ) / 2, base: minZ }, center: { q: 0, r: 0 } };
}

function generateMeshBuffers(allLayers, lodIndex, sx, sy) {
    // IMPORTANT: LOD ordering must match baker layer order in hex_backend/waffle_iron.py.
    // Baker writes layers as [24, 6, 3, 1] (large -> unit). We keep that order here.
    // If you ever change baker order, update this mapping and main.js LOD ranges together.
    const layerIdx = Math.min(3, Math.max(0, lodIndex));
    const hexes = allLayers[layerIdx];
    if (!hexes || hexes.length === 0) return null;

    const scaleTable = [24.0, 6.0, 3.0, 1.0];
    const scale = scaleTable[layerIdx];
    const num = hexes.length;

    const h_eff = UNIT_HEX_WIDTH_METERS * scale;
    const dx = (Math.sqrt(3) / 2) * h_eff;
    const dy = h_eff;
    const dy_q = 0.5 * h_eff;

    const sectorMinX = sx * SECTOR_WIDTH_METERS;
    const sectorMaxY = (sy + 1) * SECTOR_WIDTH_METERS;

    // Buffers
    const matrix = new Float32Array(num * 16);
    const nz1 = new Float32Array(num * 4);
    const nz2 = new Float32Array(num * 4);
    const slopes = new Float32Array(num * 3);
    const deltas = new Float32Array(num * 3);
    const norms = new Float32Array(num * 2);

    let activeSkirts = 0;

    for (let i = 0; i < num; i++) {
        const hx = hexes[i];

        // 1. Matrix (Translation)
        const gx = hx.q * dx;
        const gy = hx.r * dy + hx.q * dy_q;

        // Revised Local Pos centering logic to match user's latest fix
        const lx = (gx - sectorMinX) - SECTOR_WIDTH_METERS * 0.5;
        const lz = (sectorMaxY - gy) - SECTOR_WIDTH_METERS * 0.5;

        // Identity with translation
        const mIdx = i * 16;
        matrix[mIdx + 0] = 1; matrix[mIdx + 4] = 0; matrix[mIdx + 8] = 0; matrix[mIdx + 12] = lx;
        matrix[mIdx + 1] = 0; matrix[mIdx + 5] = 1; matrix[mIdx + 9] = 0; matrix[mIdx + 13] = 0;
        matrix[mIdx + 2] = 0; matrix[mIdx + 6] = 0; matrix[mIdx + 10] = 1; matrix[mIdx + 14] = lz;
        matrix[mIdx + 3] = 0; matrix[mIdx + 7] = 0; matrix[mIdx + 11] = 0; matrix[mIdx + 15] = 1;

        // 2. Attributes
        const hh = hx.h;
        const n1 = i * 4;
        nz1[n1] = hh; nz1[n1 + 1] = hh; nz1[n1 + 2] = hh; nz1[n1 + 3] = hh;
        nz2[n1] = hh; nz2[n1 + 1] = hh; nz2[n1 + 2] = hh; nz2[n1 + 3] = 0.0;

        const sIdx = i * 3;
        slopes[sIdx] = hx.slopes[0]; slopes[sIdx + 1] = hx.slopes[1]; slopes[sIdx + 2] = hx.slopes[2];

        const dIdx = i * 3;
        deltas[dIdx] = hx.deltas[0]; deltas[dIdx + 1] = hx.deltas[1]; deltas[dIdx + 2] = hx.deltas[2];

        const nIdx = i * 2;
        norms[nIdx] = hx.norm[0] / 255.0; norms[nIdx + 1] = hx.norm[1] / 255.0;

        if (hx.deltas.some(v => v !== 0)) activeSkirts++;
    }

    return { matrix, nz1, nz2, slopes, deltas, norms, activeSkirts };
}


# ================================================================================
# FILE 10/13
# Path: frontend/app/vram_ledger.js
# ================================================================================

// @atlas: The 'VRAMLedger' class. A deterministic GPU memory tracking system that tallies byte-level allocations for hex geometries and textures. It also monitors incoming network payload sizes and provides spatial memory analysis (frustum intersection and distance bucketing) to support CacheManager eviction strategies.
/**
 * VRAMLedger — Deterministic VRAM & Network Telemetry Registry
 * 
 * Tracks every byte allocated to GPU memory (geometry buffers + textures)
 * and every byte pulled over the network. Each entry is tagged with sector
 * coordinates for spatial analysis (The Radar).
 */

import * as THREE from 'three';

export class VRAMLedger {
    constructor() {
        /** @type {Map<string, {geometryBytes: number, textureBytes: number, q: number, r: number, lx: number, lz: number}>} */
        this.entries = new Map();

        // Running totals (kept in sync to avoid re-summing the map each frame)
        this.totalGeometryBytes = 0;
        this.totalTextureBytes = 0;
        this.totalNetworkBytes = 0;

        // Network breakdown (cumulative — never decreases)
        this._networkBin = 0;
        this._networkTex = 0;

        // Eviction counter (lifetime)
        this.evictionCount = 0;
    }

    /** Total estimated GPU memory (geometry + textures) */
    get totalVRAMBytes() {
        return this.totalGeometryBytes + this.totalTextureBytes;
    }

    // ─── Registration ──────────────────────────────────────────────

    /**
     * Register a newly instantiated tile's GPU footprint.
     * @param {string} key - Tile key "q_r"
     * @param {{geometryBytes: number, textureBytes: number, q: number, r: number, lx: number, lz: number}} entry
     */
    register(key, entry) {
        // If already registered (shouldn't happen, but safety), deregister first
        if (this.entries.has(key)) this.deregister(key);

        this.entries.set(key, {
            geometryBytes: entry.geometryBytes,
            textureBytes: entry.textureBytes,
            q: entry.q,
            r: entry.r,
            lx: entry.lx,
            lz: entry.lz,
        });

        this.totalGeometryBytes += entry.geometryBytes;
        this.totalTextureBytes += entry.textureBytes;
    }

    /**
     * Update texture bytes when a tile's texture is upgraded (low → full res).
     * @param {string} key - Tile key "q_r"
     * @param {number} newTextureBytes - New texture GPU footprint
     */
    updateTexture(key, newTextureBytes) {
        const entry = this.entries.get(key);
        if (!entry) return;

        this.totalTextureBytes -= entry.textureBytes;
        entry.textureBytes = newTextureBytes;
        this.totalTextureBytes += newTextureBytes;
    }

    /**
     * Remove a tile from tracking (called on unload/eviction).
     * @param {string} key - Tile key "q_r"
     */
    deregister(key) {
        const entry = this.entries.get(key);
        if (!entry) return;

        this.totalGeometryBytes -= entry.geometryBytes;
        this.totalTextureBytes -= entry.textureBytes;
        this.entries.delete(key);
    }

    // ─── Network Telemetry ─────────────────────────────────────────

    /**
     * Record bytes received over the network.
     * @param {string} key - Tile key "q_r"
     * @param {{bin: number, tex: number}} bytes
     */
    addNetworkPayload(key, bytes) {
        if (bytes.bin) { this._networkBin += bytes.bin; this.totalNetworkBytes += bytes.bin; }
        if (bytes.tex) { this._networkTex += bytes.tex; this.totalNetworkBytes += bytes.tex; }
    }

    // ─── Spatial Analysis (The Radar) ──────────────────────────────

    /**
     * Compute spatial memory distribution by testing each tile against the
     * camera frustum and distance.
     * 
     * @param {THREE.Frustum} frustum - Current camera frustum
     * @param {THREE.Vector3} cameraPosition - Current camera world position
     * @param {Map} tilesMap - PistonViewer.tiles (to access bounding boxes)
     * @returns {{ inFrustumBytes: number, outFrustumBytes: number, nearBytes: number, midBytes: number, farBytes: number, tileBreakdown: {inFrustum: number, outFrustum: number} }}
     */
    getSpatialBreakdown(frustum, cameraPosition, tilesMap) {
        const result = {
            inFrustumBytes: 0,
            outFrustumBytes: 0,
            nearBytes: 0,   // < 2000m
            midBytes: 0,    // 2000–5000m
            farBytes: 0,    // > 5000m
            tileBreakdown: { inFrustum: 0, outFrustum: 0 },
        };

        const _tmpVec = new THREE.Vector3();

        for (const [key, entry] of this.entries) {
            const tileBytes = entry.geometryBytes + entry.textureBytes;
            const tile = tilesMap?.get(key);

            // Frustum test: use tile bounds if available, otherwise positional check
            let inFrustum = true;
            if (tile?.bounds && frustum) {
                inFrustum = frustum.intersectsBox(tile.bounds);
            }

            if (inFrustum) {
                result.inFrustumBytes += tileBytes;
                result.tileBreakdown.inFrustum++;
            } else {
                result.outFrustumBytes += tileBytes;
                result.tileBreakdown.outFrustum++;
            }

            // Distance bucketing
            _tmpVec.set(entry.lx, 0, entry.lz);
            const dist = _tmpVec.distanceTo(cameraPosition);

            if (dist < 2000) {
                result.nearBytes += tileBytes;
            } else if (dist < 5000) {
                result.midBytes += tileBytes;
            } else {
                result.farBytes += tileBytes;
            }
        }

        return result;
    }

    // ─── Utility ───────────────────────────────────────────────────

    /** Format bytes as human-readable string */
    static formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1048576).toFixed(1)} MB`;
    }
}


# ================================================================================
# FILE 11/13
# Path: frontend/landing/gosper.html
# ================================================================================

<!-- @atlas: The 'Gosper Curve' mathematical visualizer. An interactive, standalone HTML presentation page demonstrating the hierarchical subdivision properties of hexagonal grids. It allows users to visually step through the recursive fractal generation, illustrating how hexes can be subdivided without introducing standard Cartesian distortion. -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GPU-Style Hexagon Rendering</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            background: #0a0a0f;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            font-family: 'Courier New', monospace;
            overflow: hidden;
        }

        .container {
            position: relative;
            width: 100vw;
            height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
        }

        .hexagon-container {
            position: relative;
            width: 500px;
            height: 500px;
        }

        .triangle {
            position: absolute;
            width: 100%;
            height: 100%;
            background: #4a9eff;
            cursor: pointer;
            transition: background 0.15s ease;
        }

        .triangle:hover {
            background: #ff6b6b;
        }

        .info-panel {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(0, 20, 40, 0.9);
            border: 1px solid #4a9eff;
            border-radius: 8px;
            padding: 20px;
            color: #4a9eff;
            font-size: 14px;
            z-index: 100;
            min-width: 220px;
        }

        .info-panel h2 {
            margin: 0 0 15px 0;
            font-size: 16px;
            border-bottom: 1px solid #4a9eff;
            padding-bottom: 10px;
        }

        .info-panel .stat {
            margin: 8px 0;
            display: flex;
            justify-content: space-between;
        }

        .info-panel .value {
            color: #ffffff;
            font-weight: bold;
        }

        .info-panel .label {
            color: #888;
        }

        .gpu-log {
            position: fixed;
            bottom: 20px;
            left: 20px;
            background: rgba(0, 20, 40, 0.9);
            border: 1px solid #4a9eff;
            border-radius: 8px;
            padding: 15px;
            color: #00ff00;
            font-size: 12px;
            z-index: 100;
            font-family: 'Courier New', monospace;
            max-height: 200px;
            overflow-y: auto;
            width: 300px;
        }

        .gpu-log h3 {
            margin: 0 0 10px 0;
            font-size: 12px;
            color: #4a9eff;
            border-bottom: 1px solid #4a9eff;
            padding-bottom: 5px;
        }

        .log-entry {
            margin: 2px 0;
            padding: 2px 0;
            border-bottom: 1px solid rgba(74, 158, 255, 0.2);
        }



        .controls {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: rgba(0, 20, 40, 0.9);
            border: 1px solid #4a9eff;
            border-radius: 8px;
            padding: 15px;
            color: #4a9eff;
            font-size: 12px;
            z-index: 100;
        }

        .controls div {
            margin: 5px 0;
        }
    </style>
</head>
<body>
    <div class="container" id="container">
        <div class="hexagon-container" id="hexagon">
        </div>
    </div>

    <div class="info-panel">
        <h2>GPU RENDER STATS</h2>
        <div class="stat">
            <span class="label">Triangles Rendered:</span>
            <span class="value" id="triangleCount">0</span>
        </div>
        <div class="stat">
            <span class="label">Current Level:</span>
            <span class="value" id="level">0</span>
        </div>
        <div class="stat">
            <span class="label">Hexagons:</span>
            <span class="value" id="hexCount">0</span>
        </div>
    </div>

    <div class="gpu-log">
        <h3>GPU COMMAND LOG</h3>
        <div id="gpuLog">
        </div>
    </div>

        <div class="controls">
            <div>[SPACE] Next Level</div>
            <div>[R] Reset</div>
        </div>

    <script>
        let triangleCount = 0;
        let currentLevel = 0;
        const GOSPER_ANGLE = 19.10660535;
        const GOSPER_SCALE = 1 / Math.sqrt(7);

        function logGpuCommand(command) {
            const logDiv = document.getElementById('gpuLog');
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            const timestamp = new Date().toLocaleTimeString();
            entry.textContent = `[${timestamp}] ${command}`;
            logDiv.insertBefore(entry, logDiv.firstChild);

            if (logDiv.children.length > 50) {
                logDiv.removeChild(logDiv.lastChild);
            }
        }

        function renderTriangle(startAngle, endAngle, centerX, centerY, rotation, scale, parentElement, hexRadius = 50) {
            triangleCount++;
            logGpuCommand(`RENDER_TRIANGLE ${triangleCount}: angle=${startAngle.toFixed(1)}°-${endAngle.toFixed(1)}°, rot=${rotation.toFixed(4)}°, scale=${scale.toFixed(6)}`);

            const toRadians = (degrees) => degrees * Math.PI / 180;

            const centerVertex = [centerX, centerY];

            const startRad = toRadians(startAngle);
            const startVertex = [
                centerX + hexRadius * Math.cos(startRad),
                centerY + hexRadius * Math.sin(startRad)
            ];

            const endRad = toRadians(endAngle);
            const endVertex = [
                centerX + hexRadius * Math.cos(endRad),
                centerY + hexRadius * Math.sin(endRad)
            ];

            const trianglePoints = [centerVertex, startVertex, endVertex];

            const triangle = document.createElement('div');
            triangle.className = 'triangle';
            triangle.dataset.rotation = rotation;
            triangle.dataset.scale = scale;

            const clipPathString = trianglePoints.map(p => `${p[0]}% ${p[1]}%`).join(', ');
            triangle.style.clipPath = `polygon(${clipPathString})`;

            if (rotation !== 0 || scale !== 1) {
                triangle.style.transform = `rotate(${rotation}deg) scale(${scale})`;
            }

            parentElement.appendChild(triangle);
            return triangle;
        }

        function createHexagon(container, offsetX, offsetY, rotation, scale) {
            logGpuCommand(`CREATE_HEXAGON: offset=(${offsetX.toFixed(1)},${offsetY.toFixed(1)}), rot=${rotation.toFixed(4)}°, scale=${scale.toFixed(6)}`);

            const hexSize = 100;
            const hexWrapper = document.createElement('div');
            hexWrapper.style.position = 'absolute';
            hexWrapper.style.width = hexSize + 'px';
            hexWrapper.style.height = hexSize + 'px';
            hexWrapper.style.left = `calc(50% + ${offsetX}px - ${hexSize/2}px)`;
            hexWrapper.style.top = `calc(50% + ${offsetY}px - ${hexSize/2}px)`;

            if (rotation !== 0 || scale !== 1) {
                hexWrapper.style.transform = `rotate(${rotation}deg) scale(${scale})`;
            }

            const centerX = 50;
            const centerY = 50;
            const hexRadius = 50;

            const angles = [0, 60, 120, 180, 240, 300];

            for (let i = 0; i < 6; i++) {
                const startAngle = angles[i];
                const endAngle = angles[(i + 1) % 6];

                renderTriangle(startAngle, endAngle, centerX, centerY, rotation, scale, hexWrapper, hexRadius);
            }

            container.appendChild(hexWrapper);
            return hexWrapper;
        }

        function clearContainer() {
            const container = document.getElementById('hexagon');
            container.innerHTML = '';
        }

        function axialToPixel(q, r, hexSize) {
            const x = hexSize * 3/2 * q;
            const y = hexSize * Math.sqrt(3) * (q/2 + r);
            return { x, y };
        }

        function renderLevel(level) {
            clearContainer();
            triangleCount = 0;

            const container = document.getElementById('hexagon');

            if (level === 0) {
                createHexagon(container, 0, 0, 0, 1);
            } else if (level === 1) {
                const hexRadius = 50;
                const neighborDistance = hexRadius * Math.sqrt(3);

                const positions = [
                    { x: 0, y: 0 },
                ];

                const neighborAngles = [0, 60, 120, 180, 240, 300];
                neighborAngles.forEach(angle => {
                    const rad = angle * Math.PI / 180;
                    positions.push({
                        x: neighborDistance * Math.cos(rad),
                        y: neighborDistance * Math.sin(rad)
                    });
                });

                positions.forEach(pos => {
                    createHexagon(container, pos.x, pos.y, 0, 1);
                });
            }

            updateStats();
        }

        function updateStats() {
            const hexCount = Math.pow(7, currentLevel);
            document.getElementById('triangleCount').textContent = triangleCount;
            document.getElementById('level').textContent = currentLevel;
            document.getElementById('hexCount').textContent = hexCount;
        }

        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space') {
                e.preventDefault();
                currentLevel++;
                if (currentLevel > 1) {
                    currentLevel = 0;
                }
                renderLevel(currentLevel);
            } else if (e.code === 'KeyR') {
                currentLevel = 0;
                renderLevel(currentLevel);
            }
        });

        renderLevel(0);
    </script>
</body>
</html>


# ================================================================================
# FILE 12/13
# Path: frontend/landing/index.html
# ================================================================================

<!-- @atlas: The primary PowFinder marketing and tech-demo landing page. Features extensive visual explanations of the 'Hexagons are the Bestagons' philosophy, detailing anti-aliasing benefits, the 16-byte binary packing structure, and interactive components like the 3-Axis Diamond Sampling visualization to educate users on the engine's architecture. -->
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>The Hexagonal Advantage | PowFinder Tech</title>
    <link
        href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@400;700&display=swap"
        rel="stylesheet">
    <style>
        :root {
            --pink: #ff6b9d;
            --dark-pink: #e55a87;
            --blue: #74b9ff;
            --ice: #a2d2ff;
            --bg: #070a14;
            --panel: rgba(15, 23, 42, 0.6);
            --border: rgba(255, 107, 157, 0.2);
            --text: #e2e8f0;
            --text-dim: #94a3b8;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            background-color: var(--bg);
            color: var(--text);
            font-family: 'Outfit', sans-serif;
            line-height: 1.6;
            overflow-x: hidden;
            background-image:
                radial-gradient(circle at 20% 20%, rgba(116, 185, 255, 0.05) 0%, transparent 40%),
                radial-gradient(circle at 80% 80%, rgba(255, 107, 157, 0.05) 0%, transparent 40%);
        }

        /* Hero Section */
        .hero {
            height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 20px;
            position: relative;
        }

        .hero h1 {
            font-size: clamp(3rem, 10vw, 6rem);
            font-weight: 800;
            letter-spacing: -2px;
            margin-bottom: 20px;
            background: linear-gradient(135deg, var(--blue), var(--pink));
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
            filter: drop-shadow(0 0 30px rgba(255, 107, 157, 0.3));
        }

        .hero p {
            font-size: 1.4rem;
            color: var(--text-dim);
            max-width: 600px;
            margin-bottom: 40px;
        }

        .scroll-indicator {
            position: absolute;
            bottom: 30px;
            animation: bounce 2s infinite;
        }

        @keyframes bounce {

            0%,
            20%,
            50%,
            80%,
            100% {
                transform: translateY(0);
            }

            40% {
                transform: translateY(-10px);
            }

            60% {
                transform: translateY(-5px);
            }
        }

        /* Content Container */
        .article {
            max-width: 1000px;
            margin: 0 auto;
            padding: 100px 20px;
        }

        section {
            margin-bottom: 150px;
        }

        h2 {
            font-size: 2.5rem;
            color: var(--blue);
            margin-bottom: 30px;
            display: flex;
            align-items: center;
            gap: 15px;
        }

        h2 b {
            color: var(--pink);
        }

        .glass-panel {
            background: var(--panel);
            backdrop-filter: blur(12px);
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 40px;
            margin-bottom: 40px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        }

        p {
            margin-bottom: 20px;
            font-size: 1.1rem;
            color: var(--text-dim);
        }

        strong {
            color: var(--pink);
            font-weight: 600;
        }

        /* Canvas Styles (Homer/DeVito) */
        .prover-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin: 40px 0;
        }

        .prover-item {
            position: relative;
            background: #000;
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .prover-label {
            position: absolute;
            top: 10px;
            left: 10px;
            background: rgba(0, 0, 0, 0.8);
            padding: 4px 10px;
            font-size: 0.8rem;
            border-radius: 4px;
            color: var(--blue);
            z-index: 10;
        }

        canvas {
            width: 100%;
            height: auto;
            display: block;
            image-rendering: pixelated;
        }

        .controls {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin-top: 20px;
        }

        .btn {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--border);
            color: var(--text);
            padding: 10px 25px;
            border-radius: 30px;
            cursor: pointer;
            font-family: inherit;
            font-weight: 600;
            transition: all 0.3s;
        }

        .btn.active {
            background: var(--pink);
            color: #000;
            border-color: var(--pink);
            box-shadow: 0 0 20px rgba(255, 107, 157, 0.4);
        }

        /* Bit Packing Section */
        .byte-map {
            display: grid;
            grid-template-columns: repeat(8, 1fr);
            gap: 10px;
            margin: 40px 0;
        }

        .byte-cell {
            background: rgba(116, 185, 255, 0.1);
            border: 1px solid var(--blue);
            padding: 15px 5px;
            text-align: center;
            border-radius: 8px;
            transition: transform 0.3s;
        }

        .byte-cell:hover {
            transform: translateY(-5px);
            background: rgba(116, 185, 255, 0.2);
        }

        .byte-cell .name {
            display: block;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.9rem;
            color: var(--blue);
        }

        .byte-cell .size {
            font-size: 0.7rem;
            opacity: 0.5;
        }

        .byte-cell.pink {
            border-color: var(--pink);
            background: rgba(255, 107, 157, 0.1);
        }

        .byte-cell.pink .name {
            color: var(--pink);
        }

        /* Comparison Image Styles */
        .comparison-container {
            display: flex;
            gap: 20px;
            margin: 40px 0;
        }

        .comparison-container div {
            flex: 1;
        }

        .comparison-container img {
            width: 100%;
            aspect-ratio: 16 / 9;
            object-fit: cover;
            border-radius: 12px;
            border: 1px solid var(--border);
            display: block;
        }

        .comparison-caption {
            font-size: 0.9rem;
            text-align: center;
            margin-top: 10px;
            color: var(--text-dim);
        }

        /* Footer */
        footer {
            text-align: center;
            padding: 100px 20px;
            border-top: 1px solid var(--border);
        }

        .launch-btn {
            display: inline-block;
            background: linear-gradient(135deg, var(--pink), var(--dark-pink));
            color: #fff;
            padding: 20px 50px;
            border-radius: 40px;
            text-decoration: none;
            font-weight: 800;
            font-size: 1.2rem;
            box-shadow: 0 10px 30px rgba(255, 107, 157, 0.4);
            transition: all 0.3s;
        }

        .launch-btn:hover {
            transform: scale(1.05);
            box-shadow: 0 15px 40px rgba(255, 107, 157, 0.6);
        }

        /* Responsive */
        @media (max-width: 768px) {
            .prover-grid {
                grid-template-columns: 1fr;
            }

            .comparison-container {
                flex-direction: column;
            }

            .byte-map {
                grid-template-columns: repeat(4, 1fr);
            }

            h2 {
                font-size: 2rem;
            }
        }

        /* Diamond Demo */
        .diamond-wrapper {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 40px;
            margin: 40px 0;
            flex-wrap: wrap;
        }

        #diamond-canvas {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border);
            border-radius: 12px;
            box-shadow: 0 0 30px rgba(0, 0, 0, 0.3);
        }

        .diamond-legend {
            flex: 1;
            min-width: 250px;
        }

        .legend-row {
            display: flex;
            align-items: center;
            gap: 15px;
            margin-bottom: 20px;
            background: rgba(255, 255, 255, 0.03);
            padding: 15px;
            border-radius: 8px;
            border-left: 3px solid transparent;
        }

        .legend-row strong {
            display: block;
            color: white;
            font-size: 1.1rem;
        }

        .pulse-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #555;
            box-shadow: 0 0 10px currentColor;
        }


        /* Image Comparison Slider (Clip-Path Method) */
        .comparison-slider {
            position: relative;
            width: 100%;
            aspect-ratio: 3 / 2;
            border-radius: 24px;
            overflow: hidden;
            border: 2px solid var(--border);
            user-select: none;
            cursor: ew-resize;
            margin: 40px 0;
            background: #000;
        }

        .slider-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
        }

        /* The Background Layer (Strava) */
        .slider-after {
            z-index: 1;
        }

        /* The Overlay Layer (PowFinder) */
        .slider-before {
            z-index: 2;
            width: 100% !important;
            /* Always full width */
            height: 100%;
            top: 0;
            left: 0;
            position: absolute;
            clip-path: inset(0 25% 0 0);
            /* Reveals left 75%, showing 25% Strava on the right */
        }

        /* The Vertical Handle */
        .slider-handle {
            position: absolute;
            top: 0;
            left: 75%;
            width: 3px;
            height: 100%;
            background: var(--blue);
            z-index: 3;
            transform: translateX(-50%);
            pointer-events: none;
        }

        .slider-circle {
            position: absolute;
            top: 50%;
            left: 50%;
            width: 44px;
            height: 44px;
            background: var(--blue);
            border: 3px solid var(--bg);
            border-radius: 50%;
            transform: translate(-50%, -50%);
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 0 20px rgba(116, 185, 255, 0.4);
            pointer-events: auto;
        }

        .slider-circle svg {
            color: var(--bg);
            width: 20px;
            height: 20px;
        }

        .slider-label {
            position: absolute;
            top: 20px;
            padding: 8px 16px;
            background: rgba(0, 0, 0, 0.85);
            border-radius: 6px;
            font-size: 0.7rem;
            font-weight: 800;
            letter-spacing: 1px;
            z-index: 4;
            backdrop-filter: blur(8px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            text-transform: uppercase;
        }

        .label-before {
            left: 20px;
            color: var(--blue);
        }

        .label-after {
            right: 20px;
            color: #ff6b6b;
        }
    </style>
</head>

<body>

    <div class="hero">
        <h1>BESTAGONS.</h1>
        <p>Why the hexagonal grid is the ultimate choice for high-fidelity terrain reconstruction.</p>
        <div class="scroll-indicator">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" style="color: var(--pink)">
                <path d="M7 13l5 5 5-5M7 6l5 5 5-5" />
            </svg>
        </div>
    </div>

    <main class="article">

        <section id="sampling">
            <h2>01. The <b>Dither</b> Effect</h2>
            <div class="glass-panel">
                <div class="comparison-container" style="justify-content: center; gap: 40px; margin-bottom: 40px;">
                    <div style="text-align: center;">
                        <img src="devito.jpg"
                            style="width: 120px; height: 120px; border-radius: 50%; object-fit: cover; border: 2px solid var(--pink); margin-bottom: 10px;">
                        <span
                            style="display: block; font-size: 0.7rem; color: var(--pink); letter-spacing: 1px; font-weight: 800;">D.
                            DEVITO</span>
                    </div>
                    <div style="text-align: center;">
                        <img src="homer.png"
                            style="width: 120px; height: 120px; border-radius: 50%; object-fit: cover; border: 2px solid var(--blue); margin-bottom: 10px;">
                        <span
                            style="display: block; font-size: 0.7rem; color: var(--blue); letter-spacing: 1px; font-weight: 800;">H.
                            SIMPSON</span>
                    </div>
                </div>
                <p>
                    Standard square grids suffer from <strong>linear aliasing</strong>. They create rigid horizontal and
                    vertical "staircases" that the human eye is exceptionally good at spotting. Hexagons, by contrast,
                    utilize a 30° staggered pattern that serves as a <strong>natural reconstruction filter</strong>.
                </p>
                <p>
                    Below, we compare how Danny DeVito and Homer Simpson survive the transition to low-resolution
                    hexagonal sampling. Note how the staggered grid maintains visual continuity even when we drop the
                    sample count into the basement.
                </p>

                <div class="controls">
                    <button class="btn active" id="btn-devito">DOWNSAMPLE: DEVITO</button>
                    <button class="btn" id="btn-homer">UPSAMPLE: HOMER</button>
                </div>

                <div class="prover-grid">
                    <div class="prover-item">
                        <div class="prover-label" id="l1">1: SOURCE</div>
                        <canvas id="canv1"></canvas>
                    </div>
                    <div class="prover-item">
                        <div class="prover-label" id="l2">2: RAW IDEAL</div>
                        <canvas id="canv2"></canvas>
                    </div>
                    <div class="prover-item">
                        <div class="prover-label" id="l3">3: INTERMEDIATE</div>
                        <canvas id="canv3"></canvas>
                    </div>
                    <div class="prover-item">
                        <div class="prover-label" id="l4">4: RECONSTRUCTION</div>
                        <canvas id="canv4"></canvas>
                    </div>
                </div>

                <p style="text-align: center; font-style: italic;">
                    Toggle between modes to see how hexes "dither" data more organically than squares.
                </p>
            </div>
        </section>

        <section id="binary">
            <h2>02. Bit <b>Packing</b></h2>
            <div class="glass-panel">
                <p>
                    PowFinder moves millions of hexes in real-time. To do this, we don't send heavy JSON or bloated
                    objects. We pack every single hex into a tight <strong>16-byte binary payload</strong>. This
                    power-of-two alignment
                    is hardware-friendly and keeps the GPU buses clear.
                </p>

                <div class="byte-map">
                    <div class="byte-cell">
                        <span class="name">dq</span>
                        <span class="size">int8</span>
                    </div>
                    <div class="byte-cell">
                        <span class="name">dr</span>
                        <span class="size">int8</span>
                    </div>
                    <div class="byte-cell">
                        <span class="name">height</span>
                        <span class="size">uint16</span>
                    </div>
                    <div class="byte-cell pink">
                        <span class="name">delta SE</span>
                        <span class="size">int16</span>
                    </div>
                    <div class="byte-cell pink">
                        <span class="name">delta S</span>
                        <span class="size">int16</span>
                    </div>
                    <div class="byte-cell pink">
                        <span class="name">delta SW</span>
                        <span class="size">int16</span>
                    </div>
                    <div class="byte-cell">
                        <span class="name">slope SE</span>
                        <span class="size">uint8</span>
                    </div>
                    <div class="byte-cell">
                        <span class="name">slope S</span>
                        <span class="size">uint8</span>
                    </div>
                    <div class="byte-cell">
                        <span class="name">slope SW</span>
                        <span class="size">uint8</span>
                    </div>
                    <div class="byte-cell pink">
                        <span class="name">Norm X</span>
                        <span class="size">uint8</span>
                    </div>
                    <div class="byte-cell pink">
                        <span class="name">Norm Z</span>
                        <span class="size">uint8</span>
                    </div>
                    <div class="byte-cell">
                        <span class="name">PAD</span>
                        <span class="size">1 byte</span>
                    </div>
                </div>

                <p>
                    Every byte has a purpose. We store <strong>Vertical Deltas</strong> in decimeter precision to handle
                    the dynamic mesh seams, and <strong>Baked Normals</strong> for smooth, cinematic lighting
                    without the per-frame overhead of normal calculation.
                </p>
            </div>
        </section>

        <section id="dynamic-assembly">
            <h2>03. Seamless <b>Dynamic Assembly</b></h2>
            <div class="glass-panel">
                <p>
                    PowFinder uses a <strong>Dynamic Ownership Model</strong> to handle real-time terrain stitching.
                    By assigning each hex exactly three "owned" neighbors, the engine can calculate edge alignment
                    on-the-fly. This prevents <strong>overlapping geometry</strong> and ensures a seamless transition
                    between varying detail levels.
                </p>

                <div class="comparison-container">
                    <div>
                        <img src="square_kappl.png" alt="Square Grid Aliasing">
                        <div class="comparison-caption"><strong>SQUARES:</strong> Rigid & Crunchy</div>
                    </div>
                    <div>
                        <img src="hex_comparison.png" alt="Hex Grid Smoothness">
                        <div class="comparison-caption"><strong>HEXES:</strong> Organic & Smooth</div>
                    </div>
                </div>

                <p>
                    By generating skirts only for <strong>SE, S, and SW</strong> faces, we ensure that every edge is
                    covered exactly once. This allows us to render the entire landscape in a <strong>single draw
                        call</strong> (per LOD layer), maximizing throughput on modern GPUs.
                </p>
            </div>
        </section>

        <section id="shading">
            <h2>04. <b>3-Axis</b> Diamond Sampling</h2>
            <div class="glass-panel">
                <p>
                    In a square grid, a pixel centered on a cliff is just an "average" height. This leads to
                    <strong>cliff aliasing</strong>, where sharp drops look like soft rolling hills.
                </p>
                <p>
                    PowFinder solves this by treating every edge as a unique data channel. By sampling the "Diamond"
                    (the quad formed between two hex centers), we can render a 90° cliff on the <strong>South
                        Face</strong> while keeping the <strong>South-East Face</strong> perfectly flat.
                </p>

                <div class="diamond-wrapper">
                    <svg id="diamond-svg" width="500" height="340" viewBox="0 0 500 340"
                        style="background: rgba(0,0,0,0.3); border-radius: 12px; border: 1px solid var(--border);">
                        <defs>
                            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                                <feGaussianBlur stdDeviation="3" result="blur" />
                                <feComposite in="SourceGraphic" in2="blur" operator="over" />
                            </filter>
                        </defs>

                        <!-- 
                            PISTON LOGIC:
                            All hexes extrude down to a common "Floor" (Base Y).
                            Height is determined by the "Cap Y".

                            Grid offsets:
                            Center: (0,0)
                            SW (Left): (-67, 45) -> Moved 'closer' (down) slightly
                            SE (Right): (+67, 45)
                        -->

                        <g transform="translate(250, 60) scale(1.0)">

                            <!-- ================= CENTER HEX (BACKGROUND) ================= -->
                            <!-- High Piston -->
                            <!-- Pos: 0, 0 -->
                            <!-- Cap Y: 0 -->
                            <g transform="translate(0, 0)">
                                <title>Center Piston</title>

                                <!-- LEFT SIDE (SW Face) - Pulses GREEN -->
                                <path d="M-45 0 L-22.5 39 L-22.5 179 L-45 140 Z" fill="#1e293b">
                                    <animate attributeName="fill" values="#1e293b; #10b981; #1e293b" dur="4s"
                                        repeatCount="indefinite" calcMode="spline"
                                        keySplines="0.4 0 0.2 1; 0.4 0 0.2 1" />
                                </path>

                                <!-- CENTER SIDE (S Face) - Static Dark -->
                                <path d="M-22.5 39 L22.5 39 L22.5 179 L-22.5 179 Z" fill="#0f172a" />

                                <!-- RIGHT SIDE (SE Face) - Pulses YELLOW -->
                                <path d="M22.5 39 L45 0 L45 140 L22.5 179 Z" fill="#020617">
                                    <animate attributeName="fill" values="#020617; #eab308; #020617" dur="4s"
                                        repeatCount="indefinite" calcMode="spline"
                                        keySplines="0.4 0 0.2 1; 0.4 0 0.2 1" />
                                </path>

                                <!-- Cap Base (Dark Grey) -->
                                <path d="M45 0 L22.5 39 L-22.5 39 L-45 0 L-22.5 -39 L22.5 -39 Z" fill="#334155"
                                    stroke="white" stroke-width="2" />

                                <!-- GREEN TRIANGLE (SW Sector, Matches Left's NE) -->
                                <path d="M0 0 L-45 0 L-22.5 39 Z" fill="#10b981" fill-opacity="0.9" />

                                <!-- YELLOW TRIANGLE (SE Sector, Matches Right's NW) -->
                                <path d="M0 0 L22.5 39 L45 0 Z" fill="#eab308" fill-opacity="0.9" />
                            </g>

                            <!-- ================= LEFT HEX (FOREGROUND LEFT) ================= -->
                            <!-- Med Piston -->
                            <!-- Grid Pos: -67, 95 (Moved down/closer) -->
                            <g transform="translate(-67, 95)">
                                <title>Left Piston</title>
                                <!-- Cap Y: 15 (Medium High) -->
                                <path d="M-45 15 L-22.5 54 L-22.5 134 L-45 95 Z" fill="#1e293b" /> <!-- Left Side -->
                                <path d="M-22.5 54 L22.5 54 L22.5 134 L-22.5 134 Z" fill="#0f172a" />
                                <!-- Front Side -->
                                <path d="M22.5 54 L45 15 L45 95 L22.5 134 Z" fill="#020617" /> <!-- Right Side -->

                                <!-- Cap Base -->
                                <path d="M45 15 L22.5 54 L-22.5 54 L-45 15 L-22.5 -24 L22.5 -24 Z" fill="#1e293b"
                                    stroke="#475569" stroke-width="1" />

                                <!-- GREEN TRIANGLE (NE Sector, Matches Center's SW) -->
                                <path d="M0 15 L22.5 -24 L45 15 Z" fill="#10b981" fill-opacity="0.9" />
                            </g>

                            <!-- ================= RIGHT HEX (FOREGROUND RIGHT) ================= -->
                            <!-- Low Piston -->
                            <!-- Grid Pos: 67, 95 (Moved down/closer) -->
                            <g transform="translate(67, 95)">
                                <title>Right Piston</title>
                                <!-- Cap Y: 35 (Lowest) -->
                                <path d="M-45 35 L-22.5 74 L-22.5 134 L-45 95 Z" fill="#1e293b" />
                                <path d="M-22.5 74 L22.5 74 L22.5 134 L-22.5 134 Z" fill="#0f172a" />
                                <path d="M22.5 74 L45 35 L45 95 L22.5 134 Z" fill="#020617" />

                                <!-- Cap Base -->
                                <path d="M45 35 L22.5 74 L-22.5 74 L-45 35 L-22.5 -4 L22.5 -4 Z" fill="#1e293b"
                                    stroke="#475569" stroke-width="1" />

                                <!-- YELLOW TRIANGLE (NW Sector, Matches Center's SE) -->
                                <path d="M0 35 L-45 35 L-22.5 -4 Z" fill="#eab308" fill-opacity="0.9" />
                            </g>

                        </g>

                    </svg>

                    <div class="diamond-legend">
                        <div class="legend-row" style="border-color: #10b981;">
                            <div class="pulse-dot" style="background: #10b981;"></div>
                            <div>
                                <strong style="color: #10b981;">Green Channel</strong>
                                <span style="font-size: 0.8rem; opacity: 0.7; color: #ccc;">South-West Diamond
                                    Pair</span>
                            </div>
                        </div>
                        <div class="legend-row" style="border-color: #eab308;">
                            <div class="pulse-dot" style="background: #eab308;"></div>
                            <div>
                                <strong style="color: #eab308;">Yellow Channel</strong>
                                <span style="font-size: 0.8rem; opacity: 0.7; color: #ccc;">South-East Diamond
                                    Pair</span>
                            </div>
                        </div>
                        <p style="font-size: 0.9rem; margin-top: 20px; line-height: 1.5; color: #94a3b8;">
                            Instead of averaging heights, PowFinder creates a unique <strong>"Slope Diamond"</strong>
                            for every edge pair. This allows the Green interface to have a steep cliff while the Yellow
                            interface stays gentle, despite sharing the same central vertex.
                        </p>
                    </div>
                </div>

                <p style="text-align: center; font-style: italic; font-size: 0.9rem; opacity: 0.6;">
                    Live visualization of decoupled edge attributes.
                </p>
            </div>
        </section>

        <section id="real-world">
            <h2>05. <b>Real-World</b> Reconstruction</h2>
            <div class="glass-panel">
                <p>
                    Traditional maps prioritize routes and flat imagery. PowFinder prioritizes <strong>terrain
                        geometry</strong> using our proprietary <strong>Antisintering</strong> LOD strategy.
                </p>
                <p>
                    When you stop navigating, the engine triggers a <strong>High-Resolution Snap</strong>,
                    progressively filling in the foreground with unit-scale hexes (6m resolution). Use the sliders below
                    to compare our cinematic hexagonal reconstruction against the flat legacy satellite maps.
                </p>

                <!-- SLIDER 1: ROTADL -->
                <div class="comparison-slider" data-slider>
                    <img src="strava_rotadl.jpg" class="slider-image slider-after">
                    <div class="slider-before">
                        <img src="rotadl.png" class="slider-image">
                        <span class="slider-label label-before">POWFINDER 3D: ROTADL</span>
                    </div>
                    <span class="slider-label label-after">STRAVA TRIANGLE DUMPSTER WATER</span>
                    <div class="slider-handle">
                        <div class="slider-circle">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                                <path d="M18 8L22 12L18 16M6 8L2 12L6 16" />
                            </svg>
                        </div>
                    </div>
                </div>

                <!-- SLIDER 2: EISGRAT -->
                <div class="comparison-slider" data-slider>
                    <img src="strava_eisgrat.jpg" class="slider-image slider-after">
                    <div class="slider-before">
                        <img src="eisgrat.png" class="slider-image">
                        <span class="slider-label label-before">POWFINDER 3D: EISGRAT</span>
                    </div>
                    <span class="slider-label label-after">STRAVA TRIANGLE DUMPSTER WATER</span>
                    <div class="slider-handle">
                        <div class="slider-circle">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                                <path d="M18 8L22 12L18 16M6 8L2 12L6 16" />
                            </svg>
                        </div>
                    </div>
                </div>

                <!-- SLIDER 3: GLACIER -->
                <div class="comparison-slider" data-slider>
                    <img src="strava_glacier.jpg" class="slider-image slider-after">
                    <div class="slider-before">
                        <img src="glacier.png" class="slider-image">
                        <span class="slider-label label-before">POWFINDER 3D: GLACIER</span>
                    </div>
                    <span class="slider-label label-after">STRAVA TRIANGLE DUMPSTER WATER</span>
                    <div class="slider-handle">
                        <div class="slider-circle">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                                <path d="M18 8L22 12L18 16M6 8L2 12L6 16" />
                            </svg>
                        </div>
                    </div>
                </div>

                <p style="text-align: center; font-style: italic;">
                    Notice how the hex grid brings shadow, occlusion, and slope variance to terrain that looks "flat"
                    on standard maps.
                </p>
            </div>
        </section>
    </main>

    <footer>
        <h2 style="justify-content: center; margin-bottom: 50px;">Ready to find some <b>Steeps?</b></h2>
        <a href="../app/" class="launch-btn">LAUNCH VIEWER →</a>

    </footer>

    <script>
        // --- PROVER LOGIC ---
        const DISPLAY_PX = 512;
        const canvases = [1, 2, 3, 4].map(n => document.getElementById(`canv${n}`));
        const ctxs = canvases.map(c => c.getContext('2d'));

        let mode = 'devito';

        const assets = {
            devito: { src: 'devito.jpg', crop: 600, xOff: 150, yOff: 0 },
            homer: { src: 'homer.png', crop: 190, xOff: 0, yOff: 0 },
            mountains: { src: 'square_kappl.png', crop: 800, xOff: 0, yOff: 0 }
        };

        async function runProver() {
            const config = assets[mode];
            const img = new Image();
            img.src = config.src;
            if (mode === 'mountains') img.src = config.src; // Already absolute-ish or relative to dir

            await new Promise(r => img.onload = r);

            canvases.forEach(c => { c.width = c.height = DISPLAY_PX; });

            const off = document.createElement('canvas');
            off.width = off.height = config.crop;
            const octx = off.getContext('2d');
            octx.drawImage(img, config.xOff, config.yOff || 0, config.crop, config.crop, 0, 0, config.crop, config.crop);
            const rawData = octx.getImageData(0, 0, config.crop, config.crop).data;

            const S1_RES = mode === 'devito' ? 64 : (mode === 'homer' ? 32 : 128);
            const S2_RES = mode === 'devito' ? 32 : (mode === 'homer' ? 320 : 64);
            const HEX_RES = mode === 'devito' ? 32 : (mode === 'homer' ? 32 : 48);

            // Step 1: Source Grid
            const grid1 = [];
            const block1 = DISPLAY_PX / S1_RES;
            for (let y = 0; y < S1_RES; y++) {
                grid1[y] = [];
                for (let x = 0; x < S1_RES; x++) {
                    const i = (Math.floor(y * (config.crop / S1_RES)) * config.crop + Math.floor(x * (config.crop / S1_RES))) * 4;
                    const c = [rawData[i], rawData[i + 1], rawData[i + 2]];
                    grid1[y][x] = c;
                    ctxs[0].fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
                    ctxs[0].fillRect(x * block1, y * block1, block1, block1);
                }
            }
            document.getElementById('l1').innerHTML = `1: SOURCE (<b>${S1_RES}x${S1_RES}</b>)`;

            // Step 2: Intermediate
            const grid2 = [];
            const block2 = DISPLAY_PX / S2_RES;
            for (let y = 0; y < S2_RES; y++) {
                grid2[y] = [];
                for (let x = 0; x < S2_RES; x++) {
                    const sx = (x / (S2_RES - 1)) * (S1_RES - 1);
                    const sy = (y / (S2_RES - 1)) * (S1_RES - 1);
                    const c = bilinear(grid1, sx, sy, S1_RES);
                    grid2[y][x] = c;
                    ctxs[2].fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
                    ctxs[2].fillRect(x * block2, y * block2, block2, block2);
                }
            }
            document.getElementById('l3').innerHTML = `3: ${mode === 'devito' ? 'DOWNSAMPLE' : 'UPSAMPLE'} (<b>${S2_RES}x${S2_RES}</b>)`;

            // Hex Property Helper
            const hexW = DISPLAY_PX / HEX_RES;
            const dx = hexW * (Math.sqrt(3) / 2);
            const dy = hexW;
            const stagger = hexW / 2;
            const cols = Math.ceil(DISPLAY_PX / dx);
            const rows = Math.ceil(DISPLAY_PX / dy);

            // Step 3: Ideal Hex (From Raw)
            ctxs[1].clearRect(0, 0, DISPLAY_PX, DISPLAY_PX);
            for (let c = 0; c < cols; c++) {
                const x = c * dx;
                const offY = (c % 2 === 1) ? stagger : 0;
                for (let r = 0; r < rows; r++) {
                    const y = r * dy + offY;
                    const rx = (x / DISPLAY_PX) * config.crop;
                    const ry = (y / DISPLAY_PX) * config.crop;
                    if (rx < config.crop && ry < config.crop) {
                        const color = bilinearRaw(rawData, rx, ry, config.crop);
                        drawHex(ctxs[1], x, y, hexW, color);
                    }
                }
            }
            document.getElementById('l2').innerHTML = `2: IDEAL HEX FROM <b>RAW IMAGE</b>`;

            // Step 4: Reconstruction (From Step 1 or 2)
            ctxs[3].clearRect(0, 0, DISPLAY_PX, DISPLAY_PX);
            const sourceForHex = mode === 'devito' ? grid1 : (mode === 'mountains' ? grid1 : grid2);
            const sourceDim = mode === 'devito' ? S1_RES : (mode === 'mountains' ? S1_RES : S2_RES);
            for (let c = 0; c < cols; c++) {
                const x = c * dx;
                const offY = (c % 2 === 1) ? stagger : 0;
                for (let r = 0; r < rows; r++) {
                    const y = r * dy + offY;
                    const sx = (x / DISPLAY_PX) * (sourceDim - 1);
                    const sy = (y / DISPLAY_PX) * (sourceDim - 1);
                    if (sx < sourceDim && sy < sourceDim) {
                        const color = bilinear(sourceForHex, sx, sy, sourceDim);
                        drawHex(ctxs[3], x, y, hexW, color);
                    }
                }
            }
            document.getElementById('l4').innerHTML = `4: HEX RECONSTRUCTION (<b>${HEX_RES}x${HEX_RES}</b>)`;
        }

        function drawHex(ctx, x, y, w, c) {
            const r = w / Math.sqrt(3);
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const angle = (Math.PI / 180) * (i * 60);
                ctx.lineTo(x + r * Math.cos(angle), y + r * Math.sin(angle));
            }
            ctx.closePath(); ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fill();
        }

        function bilinear(grid, x, y, dim) {
            const x1 = Math.floor(x), x2 = Math.min(x1 + 1, dim - 1);
            const y1 = Math.floor(y), y2 = Math.min(y1 + 1, dim - 1);
            const dx = x - x1, dy = y - y1;
            const out = [];
            for (let i = 0; i < 3; i++) {
                const r1 = grid[y1][x1][i] * (1 - dx) + grid[y1][x2][i] * dx;
                const r2 = grid[y2][x1][i] * (1 - dx) + grid[y2][x2][i] * dx;
                out[i] = Math.round(r1 * (1 - dy) + r2 * dy);
            }
            return out;
        }

        function bilinearRaw(data, x, y, w) {
            const x1 = Math.floor(x), x2 = Math.min(x1 + 1, w - 1);
            const y1 = Math.floor(y), y2 = Math.min(y1 + 1, w - 1);
            const x3 = x - x1, dy = y - y1;
            const get = (px, py) => { const i = (py * w + px) * 4; return [data[i], data[i + 1], data[i + 2]]; };
            const c11 = get(x1, y1), c21 = get(x2, y1), c12 = get(x1, y2), c22 = get(x2, y2);
            const out = [];
            for (let i = 0; i < 3; i++) {
                const r1 = c11[i] * (1 - x3) + c21[i] * x3;
                const r2 = c12[i] * (1 - x3) + c22[i] * x3;
                out[i] = Math.round(r1 * (1 - dy) + r2 * dy);
            }
            return out;
        }

        document.getElementById('btn-devito').onclick = () => {
            mode = 'devito'; updateBtns(); runProver();
        };
        document.getElementById('btn-homer').onclick = () => {
            mode = 'homer'; updateBtns(); runProver();
        };


        function updateBtns() {
            document.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
            document.getElementById(`btn-${mode}`).classList.add('active');
        }

        runProver();

        // --- SLIDER LOGIC ---
        document.querySelectorAll('[data-slider]').forEach(slider => {
            const before = slider.querySelector('.slider-before');
            const handle = slider.querySelector('.slider-handle');

            const moveSlider = (e) => {
                const rect = slider.getBoundingClientRect();
                const x = (e.pageX || (e.touches && e.touches[0].pageX)) - rect.left;
                let percent = (x / rect.width) * 100;

                if (percent < 0) percent = 0;
                if (percent > 100) percent = 100;

                before.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
                handle.style.left = `${percent}%`;
            };

            const onMouseMove = (e) => {
                if (e.buttons === 1) moveSlider(e);
            };

            slider.addEventListener('mousemove', onMouseMove);
            slider.addEventListener('mousedown', moveSlider);
            slider.addEventListener('touchstart', (e) => {
                // Prevent scrolling when interacting with slider on touch
                // e.preventDefault(); 
                moveSlider(e);
            }, { passive: true });
            slider.addEventListener('touchmove', (e) => {
                moveSlider(e);
            }, { passive: true });
        });
    </script>
</body>

</html>



# ================================================================================
# FILE 13/13
# Path: frontend/landing/radial.html
# ================================================================================

<!-- @atlas: The 'Radial Painter' developer tool. A standalone HTML diagnostic page built to visualize and debug hexagonal clustering and radius math. Features interactive painting tools, color profiles, and SVG overlays to simulate how the LOD engine groups and prioritizes terrain sectors radiating outward from a camera's focal point. -->
<!DOCTYPE html>
<html>

<head>
    <title>Hex Painter - Radial Layering</title>
    <style>
        body {
            background: #020617;
            font-family: 'Outfit', 'Inter', system-ui, sans-serif;
            overflow: hidden;
            color: white;
            margin: 0;
        }

        /* Top Info */
        .header {
            position: absolute;
            top: 20px;
            left: 20px;
            z-index: 100;
            pointer-events: none;
        }

        .header h3 {
            margin: 0;
            color: #38bdf8;
            font-weight: 300;
            letter-spacing: 1px;
        }

        /* Bottom Drawer */
        .drawer {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 80px;
            background: rgba(15, 23, 42, 0.8);
            backdrop-filter: blur(20px);
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 40px;
            z-index: 1000;
            padding: 0 40px;
            box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.5);
        }

        .tool-section {
            display: flex;
            align-items: center;
            gap: 15px;
        }

        .label {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 1px;
            opacity: 0.5;
        }

        .color-palette {
            display: flex;
            gap: 10px;
        }

        .swatch {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            cursor: pointer;
            border: 2px solid transparent;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1);
        }

        .swatch:hover {
            transform: scale(1.2);
        }

        .swatch.active {
            border-color: white;
            transform: scale(1.1);
            box-shadow: 0 0 15px currentColor;
        }

        /* Swatch Colors */
        .bg-0 {
            background: #1e293b;
            color: #1e293b;
        }

        .bg-1 {
            background: #3b82f6;
            color: #3b82f6;
        }

        .bg-2 {
            background: #ef4444;
            color: #ef4444;
        }

        .bg-3 {
            background: #10b981;
            color: #10b981;
        }

        .bg-4 {
            background: #f59e0b;
            color: #f59e0b;
        }

        .bg-5 {
            background: #8b5cf6;
            color: #8b5cf6;
        }

        .radius-selector {
            display: flex;
            align-items: center;
            gap: 10px;
            background: rgba(255, 255, 255, 0.05);
            padding: 5px 15px;
            border-radius: 20px;
        }

        input[type="range"] {
            width: 150px;
            accent-color: #38bdf8;
            cursor: pointer;
        }

        .radius-value {
            font-family: monospace;
            font-size: 18px;
            color: #38bdf8;
            width: 25px;
        }

        /* Viewport */
        #viewport {
            position: absolute;
            top: 50%;
            left: 50%;
            width: 0;
            height: 0;
            cursor: crosshair;
        }

        #svg-layer {
            position: absolute;
            top: 0;
            left: 0;
            pointer-events: none;
            overflow: visible;
            z-index: 50;
        }

        #grid-container {
            transform-style: preserve-3d;
        }

        /* Hex Content */
        .hex {
            position: absolute;
            width: 52px;
            height: 60px;
            margin-left: -26px;
            margin-top: -30px;
            clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
            display: flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.1s ease, background 0.3s ease;
            will-change: transform;
            background: rgba(255, 255, 255, 0.08);
            /* The border color */
        }

        .hex::before {
            content: '';
            position: absolute;
            inset: 1px;
            background: #0f172a;
            /* Face background */
            clip-path: inherit;
            z-index: -1;
            transition: background 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .hex:hover {
            z-index: 100;
            background: rgba(255, 255, 255, 0.4);
        }

        .hex span {
            font-size: 8px;
            opacity: 0.4;
            pointer-events: none;
            transition: opacity 0.2s;
        }

        .hex:hover span {
            opacity: 1;
        }

        /* Painting classes override the ::before background */
        .p-0::before {
            background: #1e293b;
        }

        .p-1::before {
            background: #3b82f6;
        }

        .p-2::before {
            background: #ef4444;
        }

        .p-3::before {
            background: #10b981;
        }

        .p-4::before {
            background: #f59e0b;
        }

        .p-5::before {
            background: #8b5cf6;
        }
    </style>
</head>

<body>

    <div class="header">
        <h3>Radial Painter</h3>
    </div>

    <div id="viewport">
        <svg id="svg-layer"></svg>
        <div id="grid-container"></div>
    </div>

    <div class="drawer">
        <div class="tool-section">
            <span class="label">Color Profile</span>
            <div class="color-palette" id="palette">
                <div class="swatch bg-0" data-idx="0"></div>
                <div class="swatch bg-1 active" data-idx="1"></div>
                <div class="swatch bg-2" data-idx="2"></div>
                <div class="swatch bg-3" data-idx="3"></div>
                <div class="swatch bg-4" data-idx="4"></div>
                <div class="swatch bg-5" data-idx="5"></div>
            </div>
        </div>

        <div class="tool-section">
            <span class="label">Brush Layers</span>
            <div class="radius-selector">
                <input type="range" id="radiusInput" min="1" max="10" value="1">
                <span class="radius-value" id="radiusDisplay">1</span>
            </div>
        </div>

        <div class="tool-section">
            <button id="clearBtn"
                style="background:none; border: 1px solid rgba(255,255,255,0.2); color:white; padding: 5px 15px; border-radius: 4px; cursor:pointer; font-size:12px;">Clear
                All</button>
        </div>
    </div>

    <script>
        const container = document.getElementById('grid-container');
        const radiusInput = document.getElementById('radiusInput');
        const radiusDisplay = document.getElementById('radiusDisplay');
        const clearBtn = document.getElementById('clearBtn');
        const palette = document.getElementById('palette');

        const HEX_SIZE = 30; // Slightly smaller to fit more
        const GRID_LIMIT = 20; // Radius of the whole viewport

        let activeProfile = 1;
        let brushSize = 1; // 1 = center only, 2 = 1 layer, etc.

        // Hex Registry [q,r] -> Element
        const hexLookup = new Map();

        function hexToPixel(q, r) {
            const x = HEX_SIZE * Math.sqrt(3) * (q + r / 2);
            const y = HEX_SIZE * 3 / 2 * r;
            return { x, y };
        }

        function getDistance(q1, r1, q2, r2) {
            return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
        }

        function paintHex(q, r, profile) {
            const key = `${q},${r}`;
            const el = hexLookup.get(key);
            if (!el) return;

            // Remove old profile
            for (let i = 0; i < 6; i++) el.classList.remove(`p-${i}`);
            el.classList.add(`p-${profile}`);

            // Visual feedback splash
            el.animate([
                { transform: `scale(1.15)` },
                { transform: `scale(1)` }
            ], { duration: 300, easing: 'ease-out' });
        }

        function drawSuperBorder(cq, cr, size) {
            const svg = document.getElementById('svg-layer');
            const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");

            const d = size - 1; // Distance from center to corner hexes

            // Corner offsets for any Radius cluster
            const corners = [
                { q: -d, r: d }, { q: 0, r: d }, { q: d, r: 0 },
                { q: d, r: -d }, { q: 0, r: -d }, { q: -d, r: 0 }
            ];

            const points = corners.map(offset => {
                const p = hexToPixel(cq + offset.q, cr + offset.r);
                return `${Math.round(p.x)},${Math.round(p.y)}`;
            }).join(' ');

            poly.setAttribute("points", points);
            poly.setAttribute("fill", "none");
            poly.setAttribute("stroke", "white");
            poly.setAttribute("stroke-width", "2");
            poly.setAttribute("stroke-linejoin", "round");
            poly.style.filter = "drop-shadow(0 0 5px white)";
            poly.style.opacity = "0.7";

            svg.appendChild(poly);
        }

        function handleClick(q, r) {
            const maxDist = brushSize - 1;

            for (let dq = -maxDist; dq <= maxDist; dq++) {
                for (let dr = Math.max(-maxDist, -dq - maxDist); dr <= Math.min(maxDist, -dq + maxDist); dr++) {
                    paintHex(q + dq, r + dr, activeProfile);
                }
            }

            if (brushSize >= 2) {
                drawSuperBorder(q, r, brushSize);
            }
        }

        // Initialize Grid
        const fragment = document.createDocumentFragment();
        for (let q = -GRID_LIMIT; q <= GRID_LIMIT; q++) {
            let r1 = Math.max(-GRID_LIMIT, -q - GRID_LIMIT);
            let r2 = Math.min(GRID_LIMIT, -q + GRID_LIMIT);
            for (let r = r1; r <= r2; r++) {
                const el = document.createElement('div');
                el.className = 'hex';
                const pos = hexToPixel(q, r);
                el.style.transform = `translate3d(${Math.round(pos.x)}px, ${Math.round(pos.y)}px, 0)`;
                el.innerHTML = `<span>${q},${r}</span>`;

                el.onclick = () => handleClick(q, r);

                hexLookup.set(`${q},${r}`, el);
                fragment.appendChild(el);
            }
        }
        container.appendChild(fragment);

        // UI Listeners
        radiusInput.oninput = (e) => {
            brushSize = parseInt(e.target.value);
            radiusDisplay.innerText = brushSize;
        };

        palette.onclick = (e) => {
            const swatch = e.target.closest('.swatch');
            if (!swatch) return;

            document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
            swatch.classList.add('active');
            activeProfile = parseInt(swatch.dataset.idx);
        };

        clearBtn.onclick = () => {
            hexLookup.forEach(el => {
                for (let i = 0; i < 6; i++) el.classList.remove(`p-${i}`);
            });
            document.getElementById('svg-layer').innerHTML = '';
        };

    </script>
</body>

</html>

