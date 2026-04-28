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
