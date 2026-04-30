import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

(async () => {
    const headlessMode = process.argv.includes('--headless');
    const defaultPort = process.env.PORT || '8080';
    const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
    const url = args[0] || `http://localhost:${defaultPort}/`;
    const outputDir = args[1] || path.join(process.cwd(), 'hive_assets', '.test_results', `perf-${Date.now()}`);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Launch with GPU flags enabled for accurate hardware acceleration
    const browser = await chromium.launch({
        headless: headlessMode,
        args: ['--enable-webgl', '--use-gl=angle', '--enable-unsafe-webgpu', '--enable-precise-memory-info']
    });

    const context = await browser.newContext();
    // Start tracing for DevTools profiling (Flamecharts)
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    const page = await context.newPage();
    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');

    let metrics = {
        violations: { MOVING_2D: [], MOVING_3D: [], SINTERING: [], STATIC: [] },
        statsSummaries: [],
        memorySnapshots: [],
        errors: []
    };

    // 1. Intercept Structured Console Logs from main.js
    page.on('console', msg => {
        const text = msg.text();
        if (msg.type() === 'error' && !text.includes('favicon')) {
            metrics.errors.push(text);
        }

        if (text.startsWith('[PERF_VIOLATION]')) {
            try {
                const data = JSON.parse(text.replace('[PERF_VIOLATION]', '').trim());

                if (data.type === 'stats') {
                    // Rolling stats window summary
                    metrics.statsSummaries.push(data);
                    const parts = Object.entries(data.summary).map(([st, s]) =>
                        `${st}: ${s.count}× avg=${s.avg}ms [${s.min}-${s.max}ms]`);
                    console.log(`📊 STATS (${data.totalViolations} total) | ${parts.join(' | ')}`);
                } else if (data.state && metrics.violations[data.state]) {
                    // Full-fat verbose violation
                    metrics.violations[data.state].push(data);
                    console.log(`⚠️  VIOLATION [${data.state.padEnd(10)}] | ${data.duration.toFixed(1)}ms (Budget: ${data.budget}ms) | Culprits: ${data.culprits}`);
                }
            } catch (e) { }
        }

        if (text.startsWith('[MEMORY_REPORT]')) {
            try {
                metrics.memorySnapshots.push(JSON.parse(text.replace('[MEMORY_REPORT]', '').trim()));
            } catch (e) { }
        }
    });

    console.log(`🚀 Starting Performance Profiler on: ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });

    try {
        await page.waitForFunction(() => window.pistonViewer && window.pistonViewer.loaderHidden, { timeout: 15000 });
    } catch (e) {
        console.log('⚠️ Loader timeout fallback. Proceeding.');
    }

    const captureState = async (phaseName) => {
        console.log(`📸 ${phaseName}`);
        await page.waitForTimeout(500);
        const screenshotPath = path.join(outputDir, `${phaseName}.png`);
        await page.screenshot({ path: screenshotPath });

        // Black-screen detector: a blank 1280x720 PNG is ~19 KB.
        // Real terrain renders are >100 KB. Use file size as proxy.
        const fileSize = fs.statSync(screenshotPath).size;
        const isBlack = fileSize < 50_000;
        if (isBlack) console.log(`   ⚠️  BLACK SCREEN DETECTED (${(fileSize / 1024).toFixed(0)} KB — expected >100 KB)`);

        // Get stats
        const stats = await page.evaluate((phase) => {
            if (window.pistonViewer && window.pistonViewer.getDetailedStats) {
                return window.pistonViewer.getDetailedStats(phase);
            }
            return null;
        }, phaseName);

        if (stats) {
            metrics.memorySnapshots.push(stats);
            const c = stats.tileClassification;
            if (c) {
                const row = (label, emoji, d) =>
                    `   ${emoji} ${label.padEnd(10)} ${String(d.count).padStart(3)} tiles (${String(d.full).padStart(2)} full + ${String(d.low).padStart(2)} low) = ${d.vram}`;
                console.log(row('Visible', '🟢', c.visible));
                console.log(row('Buffer', '🟡', c.buffer));
                console.log(row('Vestigial', '⚪', c.vestigial));
            }
            const t = stats.tiles;
            const v = stats.vram;
            console.log(`   💾 ${v.total} / ${v.budget} (${(v.budgetUtilization * 100).toFixed(0)}%)  |  Evicted: ${t.evictedTotal}  Re-downloads: ${t.redownloads}`);
        }

        const perfData = await client.send('Performance.getMetrics');
        const jsHeap = perfData.metrics.find(m => m.name === 'JSHeapUsedSize');
        if (jsHeap) console.log(`   🧠 JS Heap: ${Math.round(jsHeap.value / (1024 * 1024))} MB`);

        return { isBlack, stats };
    };

    const canvas = await page.$('canvas');
    let box = (await canvas?.boundingBox()) || { x: 0, y: 0, width: 1280, height: 720 };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const drag = async (dx, dy, steps, modifier = null) => {
        await page.mouse.move(cx, cy);
        if (modifier) await page.keyboard.down(modifier);
        await page.mouse.down();
        await page.mouse.move(cx + dx, cy + dy, { steps });
        await page.mouse.up();
        if (modifier) await page.keyboard.up(modifier);
    };

    // ═══════════════════════════════════════════════════════════════
    // BASELINE — Confirm rendering before any movement
    // ═══════════════════════════════════════════════════════════════
    console.log('\n═══ BASELINE ═══');
    await page.waitForTimeout(3000); // Extra settle time for initial tile load
    const baseline = await captureState('00_baseline');
    if (baseline.isBlack) {
        console.log('❌ FATAL: Initial render is BLACK. Aborting test — no tiles visible.');
        await context.tracing.stop({ path: path.join(outputDir, 'trace.zip') });
        fs.writeFileSync(path.join(outputDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
        await browser.close();
        process.exit(1);
    }

    // ═══════════════════════════════════════════════════════════════
    // SUB 1: 2D STRESS — Westward scroll + eastward cache test
    // ═══════════════════════════════════════════════════════════════
    console.log('\n═══ SUB 1: 2D STRESS ═══');

    // Westward scroll (8× 400px ≈ 6.5 km, enough to force evictions at 5 GB)
    console.log('   → Scrolling west (8 drags)...');
    for (let i = 0; i < 8; i++) {
        await drag(400, 0, 25);
        await page.waitForTimeout(100);
    }
    await captureState('01_2d_scrolled_west');

    // Eastward return — should hit cache (zero new re-downloads)
    console.log('   ↩️  Returning east (cache test, 500px)...');
    await drag(-500, 0, 25);
    await page.waitForTimeout(300);
    await captureState('02_2d_cache_return');

    // ═══════════════════════════════════════════════════════════════
    // SUB 2: 3D STRESS — Mild tilt + multi-direction exploration
    // ═══════════════════════════════════════════════════════════════
    console.log('\n═══ SUB 2: 3D STRESS ═══');

    // Mild ~20° tilt into 3D
    await drag(0, -30, 20, 'Control');
    await page.waitForTimeout(300);

    // Explore: pan west, south, east, north
    console.log('   → Exploring 3D (4 direction pans)...');
    await drag(300, 0, 20); await page.waitForTimeout(100);
    await drag(0, 200, 20); await page.waitForTimeout(100);
    await drag(-300, 0, 20); await page.waitForTimeout(100);
    await drag(0, -200, 20); await page.waitForTimeout(100);

    // Additional long westward 3D pan
    console.log('   → Long 3D westward pan (5 drags)...');
    for (let i = 0; i < 5; i++) {
        await drag(300, 20, 20);
        await page.waitForTimeout(80);
    }
    await captureState('03_3d_explored');

    // ═══════════════════════════════════════════════════════════════
    // SUB 3: SETTLING — Sintering + static rest
    // ═══════════════════════════════════════════════════════════════
    console.log('\n═══ SUB 3: SETTLING ═══');

    console.log('   🔥 Sintering (6s)...');
    await page.waitForTimeout(6000);
    await captureState('04_sintered');

    console.log('   🧘 Static rest (2s)...');
    await page.waitForTimeout(2000);
    await captureState('05_static');

    // Stop Tracing
    console.log('\n💾 Saving Traces & Reports...');
    await context.tracing.stop({ path: path.join(outputDir, 'trace.zip') });
    fs.writeFileSync(path.join(outputDir, 'metrics.json'), JSON.stringify(metrics, null, 2));

    console.log('\n=== ANALYSIS SUMMARY ===');
    console.log(`Violations -> 2D: ${metrics.violations.MOVING_2D.length} | 3D: ${metrics.violations.MOVING_3D.length} | Sintering: ${metrics.violations.SINTERING.length} | Static: ${metrics.violations.STATIC.length}`);
    console.log(`📁 Artifacts saved to: ${outputDir}`);
    console.log(`   - trace.zip (Drop into Chrome DevTools Performance Tab)`);
    console.log('========================\n');

    await browser.close();
    process.exit(0);
})();