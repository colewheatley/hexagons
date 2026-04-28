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
