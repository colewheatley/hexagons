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
