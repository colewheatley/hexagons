import fetch from 'node-fetch';

const HEADERS = {
    "Referer": "https://og.realitymaps.de/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

const BASE = "https://tms2.realitymaps.de";
const LAYERS = [
    "Satellite_Winter_2022",
    "Satellite_Winter_2023",
    "Satellite_Winter",
    "aerial-winter",
    "winter-aerial",
    "winter",
    "ortho_winter"
];
const EXTS = [".jpeg", ".jpg", ".webp"];
const Z = 11;
const X = 1088;

// Innsbruck Z11 TMS Y = 1329
const Y_RANGES = [
    { start: 1328, end: 1330, name: "TMS/Inverted" }
];

async function check(url) {
    try {
        const resp = await fetch(url, { headers: HEADERS, method: 'HEAD' });
        if (resp.status === 200) {
            console.log(`[SUCCESS] ${url}`);
            return true;
        } else if (resp.status !== 404) {
            // console.log(`[${resp.status}] ${url}`);
        }
    } catch (e) {
        // ignore
    }
    return false;
}

async function run() {
    console.log("Scanning tile grid...");
    
    for (const layer of LAYERS) {
        for (const ext of EXTS) {
            for (const range of Y_RANGES) {
                for (let y = range.start; y <= range.end; y++) {
                    const url = `${BASE}/${layer}/${Z}/${X}/${y}${ext}`;
                    await check(url);
                }
            }
        }
    }
    console.log("Scan complete.");
}

run();
