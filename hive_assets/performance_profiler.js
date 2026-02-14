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
                if (metrics.violations[data.state]) {
                    metrics.violations[data.state].push(data);
                }
                console.log(`⚠️  VIOLATION [${data.state.padEnd(10)}] | ${data.duration.toFixed(1)}ms (Budget: ${data.budget}ms) | Culprits: ${data.culprits}`);
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
        console.log(`📸 Capturing Phase: ${phaseName.padEnd(15)}`);
        await page.waitForTimeout(500); // Let UI settle
        await page.screenshot({ path: path.join(outputDir, `${phaseName}.png`) });

        // Force explicit memory dump from the app's new architecture
        await page.evaluate((phase) => {
            if (window.pistonViewer && window.pistonViewer.getDetailedStats) {
                const stats = window.pistonViewer.getDetailedStats(phase);
                console.log('[MEMORY_REPORT] ' + JSON.stringify(stats));
            }
        }, phaseName);

        // Capture CDP JS Heap
        const perfData = await client.send('Performance.getMetrics');
        const jsHeap = perfData.metrics.find(m => m.name === 'JSHeapUsedSize');
        if (jsHeap) console.log(`   -> CDP JS Heap: ${Math.round(jsHeap.value / (1024 * 1024))} MB`);
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

    // --- PHASE 1: 2D MOVING ---
    console.log('\n🏃 Executing: 2D Moving');
    await drag(-300, 0, 20);
    await page.waitForTimeout(200);
    await drag(300, 0, 20);
    await captureState('01_moving_2d');

    // --- PHASE 2: 3D MOVING ---
    console.log('\n🏔️ Executing: 3D Moving');
    await drag(0, -150, 20, 'Control'); // Pitch up into 3D
    await page.waitForTimeout(200);
    await drag(-400, 50, 30); // Long 3D pan
    await captureState('02_moving_3d');

    // --- PHASE 3: SINTERING ---
    console.log('\n🔥 Executing: Sintering (Waiting 6s for worker queues)');
    await page.waitForTimeout(6000);
    await captureState('03_sintering');

    // --- PHASE 4: STATIC SINTERED ---
    console.log('\n🧘 Executing: Static Rest (Waiting 2s)');
    await page.waitForTimeout(2000); // Should be completely silent (0 violations)
    await captureState('04_static_sintered');

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