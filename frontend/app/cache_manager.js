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
