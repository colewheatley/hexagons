import fetch from 'node-fetch';

const HEADERS = {
    "Referer": "https://og.realitymaps.de/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

const BASE = "https://tms2.realitymaps.de";

// Combinations of likely terms
const PREFIXES = ["", "Satellite_", "Ortho_", "DOP_", "Aerial_", "Winter_"];
const CORES = ["Winter", "winter", "winter3d", "aerial", "ortho", "dop"];
const SUFFIXES = ["", "_2022", "_2023", "_2024", "2022", "2023", "3d"];

// Valid coordinates for Innsbruck
// Z11: X=1088, Y_TMS=1329
// Z14: X=8711, Y_TMS=10632
const COORDS = [
    { z: 11, x: 1088, y: 1329 },
    { z: 14, x: 8711, y: 10632 }
];

const EXTENSIONS = [".jpeg", ".jpg", ".webp"];

async function check(layerName) {
    for (const coord of COORDS) {
        for (const ext of EXTENSIONS) {
            const url = `${BASE}/${layerName}/${coord.z}/${coord.x}/${coord.y}${ext}`;
            try {
                const resp = await fetch(url, { headers: HEADERS, method: 'HEAD' });
                if (resp.status === 200) {
                    console.log(`[FOUND!] ${url}`);
                    return true;
                } else if (resp.status === 403) {
                    console.log(`[403 Forbidden] ${url} (Layer exists but access denied)`);
                }
            } catch (e) {
                // Ignore connection errors
            }
        }
    }
    return false;
}

async function run() {
    console.log("Starting dictionary attack on layer names...");
    const candidates = new Set();

    // 1. Manual Guesses
    candidates.add("aerial-winter");
    candidates.add("winter-aerial");
    candidates.add("Satellite_Winter_2022"); // Retrying at Z14
    candidates.add("Satellite_Winter_2021");
    candidates.add("Satellite_Winter_2020");
    candidates.add("Ortho_Winter_2022");
    candidates.add("winter_ortho");
    candidates.add("winter_dop");
    candidates.add("dop_winter");
    
    // 2. Permutations
    for (const p of PREFIXES) {
        for (const c of CORES) {
            for (const s of SUFFIXES) {
                const name = `${p}${c}${s}`;
                if (name.length > 0) candidates.add(name);
                candidates.add(name.toLowerCase());
            }
        }
    }

    console.log(`Testing ${candidates.size} candidate names...`);
    
    // Run in parallel chunks
    const list = Array.from(candidates);
    const CHUNK_SIZE = 20;
    for (let i = 0; i < list.length; i += CHUNK_SIZE) {
        const chunk = list.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(name => check(name)));
    }
    console.log("Scan complete.");
}

run();
