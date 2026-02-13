import fetch from 'node-fetch';

const HEADERS = {
    "Referer": "https://og.realitymaps.de/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

const COORDS = [
    { z: 11, x: 1088, y: 1329, name: "Innsbruck Z11 TMS" }
];

const CANDIDATES = [
    "https://three-d.b-cdn.net/Data/archive/eox",
    "https://layers2.b-cdn.net/world",
    "https://layers.b-cdn.net/world-route-hike", // Just in case
    "https://layers.b-cdn.net/slopeEU"
];

async function run() {
    for (const base of CANDIDATES) {
        for (const c of COORDS) {
            // Try .webp and .jpg
            for (const ext of [".webp", ".jpg", ".jpeg"]) {
                const url = `${base}/${c.z}/${c.x}/${c.y}${ext}`;
                try {
                    const resp = await fetch(url, { headers: HEADERS, method: 'HEAD' });
                    if (resp.status === 200) {
                        console.log(`[FOUND] ${url} (${c.name})`);
                    }
                } catch (e) {}
            }
        }
    }
}

run();
