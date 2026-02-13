import fetch from 'node-fetch';

const HEADERS = {
    "Referer": "https://og.realitymaps.de/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

const BASES = [
    "https://three-d.b-cdn.net/Data/archive",
    "https://three-d.b-cdn.net/Data",
    "https://layers.b-cdn.net",
    "https://og.realitymaps.de/maunaloa/Data",
    "https://og.realitymaps.de/Data"
];

const CANDIDATES = [
    "EU", "AT", "DE", "CH", "IT",
    "Alps", "alps", "RMalps",
    "Europe", "europe",
    "Tirol", "tirol",
    "Tyrol", "tyrol",
    "CentralEurope",
    "Alpen", "alpen",
    "eox" // Control
];

// Innsbruck Z11 TMS
const Z = 11;
const X = 1088;
const Y = 1329;

const EXTS = [".webp", ".jpeg", ".jpg"];

async function check(url) {
    try {
        const resp = await fetch(url, { headers: HEADERS, method: 'HEAD' });
        if (resp.status === 200) {
            console.log(`[FOUND] ${url}`);
            return true;
        } else if (resp.status === 403) {
            console.log(`[403] ${url}`);
        }
    } catch (e) {
        // ignore
    }
    return false;
}

async function run() {
    console.log(`Scanning BunnyCDN & TMS2 for Winter Candidates at Z${Z}/${X}/${Y}...`);
    
    for (const base of BASES) {
        for (const layer of CANDIDATES) {
            for (const ext of EXTS) {
                // Standard TMS structure
                await check(`${base}/${layer}/${Z}/${X}/${Y}${ext}`);
                
                // GWC Structure (for tms2 mostly)
                if (base.includes("tms2")) {
                     // Check if it's a folder structure
                }
            }
        }
    }
    console.log("Scan complete.");
}

run();
