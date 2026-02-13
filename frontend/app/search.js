
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
