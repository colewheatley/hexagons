import fetch from 'node-fetch';

const HEADERS = {
    "Referer": "https://og.realitymaps.de/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

// Target: Innsbruck at Zoom 10
const Z = 10;
const X = 544;
const Y_XYZ = 359;
const Y_TMS = 664; // (2^10 - 1) - 359

const BASE_URLS = [
    "https://tms2.realitymaps.de"
];

const PATH_TEMPLATES = [
    // Control: alps-slopes (known string from grep)
    "/alps-slopes/10/544/359.webp",
    "/alps-slopes/10/544/664.webp",
    
    // Encoded Layer Name Guesses
    "/service/tms/1.0.0/Topokarte_2022%3Awinter3d@EPSG%3A900913@webp/10/544/664.webp",
    "/service/tms/1.0.0/Topokarte_2022%3Awinter3d@EPSG%3A3857@webp/10/544/664.webp",
    "/service/tms/1.0.0/Topokarte_2022%3Awinter3d@EPSG%3A4326@webp/10/544/664.webp",
    
    // Try EPSG:4326 (WGS84) which has different tile indices
    // Innsbruck (47.26, 11.40) at Z=10 in EPSG:4326 is approx X=1088, Y=341 (TMS Y=682)
    "/winter3d/10/1088/341.webp",
    "/winter3d/10/1088/682.webp",
    
    // Just in case: simple winter3d
    "/winter3d/10/544/664.webp"
];
async function checkUrl(baseUrl, path) {
    const url = `${baseUrl}${path}`;
    try {
        // Use GET instead of HEAD to see the body
        const resp = await fetch(url, { headers: HEADERS, method: 'GET' });
        console.log(`[${resp.status}] ${url}`);
        
        if (resp.status === 200) {
            console.log(`!!! SUCCESS !!! Found valid resource: ${url}`);
            if (url.endsWith('xml') || url.includes('json') || url.includes('GetCapabilities')) {
                 const text = await resp.text();
                 console.log("--- BODY START ---");
                 console.log(text.substring(0, 500)); // Print first 500 chars
                 console.log("--- BODY END ---");
            }
            return true;
        } else if (resp.status !== 404) {
            // Print body for 400, 403, 500, etc. to diagnose
            const text = await resp.text();
            console.log(`    -> Error Body: ${text.substring(0, 300).replace(/\n/g, ' ')}`);
        }
    } catch (e) {
        console.log(`[ERR] ${url}: ${e.message}`);
    }
    return false;
}

async function run() {
    console.log(`Probing for Innsbruck Tile Z:${Z} X:${X} Y_XYZ:${Y_XYZ} Y_TMS:${Y_TMS}`);
    
    for (const base of BASE_URLS) {
        for (const tmpl of PATH_TEMPLATES) {
            await checkUrl(base, tmpl);
        }
    }
}

run();