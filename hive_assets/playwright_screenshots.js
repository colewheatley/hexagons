import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
    // Use headed mode by default for WebGL support
    // Can override with --headless flag
    const headlessMode = process.argv.includes('--headless');
    const browser = await chromium.launch({ headless: headlessMode });
    const page = await browser.newPage();
    const outputDir = process.argv[3] || '/tmp/powfinder-test-' + Date.now();

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // METRICS OBJECT (combining Pro + Deep Think)
    let metrics = {
        // Deep Think: App-specific performance
        movingSpikes: 0,
        sinteringSpikes: 0,
        perfLogs: [],
        errors: [],

        // Pro: CDP Performance Metrics
        jsHeapSizeMB: 0,
        domNodes: 0,
        layoutCount: 0,
        styleRecalcCount: 0,

        // Combined: Visual test tracking
        screenshots: [],
        testPhases: []
    };

    // CONSOLE INTERCEPTION (Deep Think approach)
    page.on('console', msg => {
        const text = msg.text();
        const type = msg.type();

        if (type === 'error') {
            metrics.errors.push({ type: 'console', message: text, timestamp: Date.now() });
        }

        // Capture render spikes from your app
        if (text.includes('RENDER SPIKE')) {
            if (text.includes('3D-MOVING') || text.includes('VISIBILITY')) {
                metrics.movingSpikes++;
            } else {
                metrics.sinteringSpikes++;
            }
        }

        // Capture custom perf logs
        if (text.includes('[PERF]')) {
            metrics.perfLogs.push({ message: text, timestamp: Date.now() });
        }
    });

    // CDP SESSION (Pro approach)
    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');

    // NAVIGATE
    const url = process.argv[2] || 'https://wheatley.cloud/powfinder/hexagons/app/';
    console.log('Loading:', url);

    await page.goto(url, { waitUntil: 'load', timeout: 60000 });

    // Wait for app initialization (Deep Think approach)
    try {
        await page.waitForFunction(() => {
            return window.pistonViewer && window.pistonViewer.loaderHidden;
        }, { timeout: 15000 });
    } catch (e) {
        console.log('Warning: pistonViewer not detected, continuing anyway');
    }

    // PHASE 1: 2D Mode Testing (Kimi approach)
    console.log('Phase 1: 2D Mode Testing');

    // 01 - Initial
    await page.screenshot({ path: `${outputDir}/01_initial.png` });
    metrics.screenshots.push('01_initial.png');
    metrics.testPhases.push({ phase: '2d_initial', timestamp: Date.now() });

    // Capture CDP metrics at start
    let perfMetrics = await client.send('Performance.getMetrics');
    let memoryMetric = perfMetrics.metrics.find(m => m.name === 'JSHeapUsedSize');
    if (memoryMetric) metrics.jsHeapSizeMB = Math.round(memoryMetric.value / (1024 * 1024));

    // 02 - Zoom out
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outputDir}/02_zoom_out.png` });
    metrics.screenshots.push('02_zoom_out.png');

    // 03 - Zoom in
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outputDir}/03_zoom_in.png` });
    metrics.screenshots.push('03_zoom_in.png');

    // 04 - Pan left
    const canvas = await page.$('canvas');
    let box = { x: 640, y: 360, width: 0, height: 0 };
    if (canvas) {
        box = await canvas.boundingBox() || box;
    }
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX - 200, centerY, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outputDir}/04_pan_left.png` });
    metrics.screenshots.push('04_pan_left.png');

    // 05 - Pan right
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX + 200, centerY, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outputDir}/05_pan_right.png` });
    metrics.screenshots.push('05_pan_right.png');

    // PHASE 2: 3D Mode Activation (Combined Deep Think + Kimi)
    console.log('Phase 2: 3D Mode Activation');

    // Ctrl+Drag to enter 3D (Deep Think approach)
    await page.mouse.move(centerX, centerY);
    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.move(centerX, centerY - 100, { steps: 20 }); // Drag up 100px
    await page.mouse.up();
    await page.keyboard.up('Control');

    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outputDir}/06_3d_activated.png` }); // Should show floating hexes
    metrics.screenshots.push('06_3d_activated.png');
    metrics.testPhases.push({ phase: '3d_activated', timestamp: Date.now(), movingSpikes: metrics.movingSpikes });

    // PHASE 3: 3D Testing (Kimi approach)
    console.log('Phase 3: 3D Mode Testing');

    // 07 - Pan in 3D
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX - 200, centerY, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outputDir}/07_3d_pan.png` });
    metrics.screenshots.push('07_3d_pan.png');

    // 08 - Zoom in 3D
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outputDir}/08_3d_zoom.png` });
    metrics.screenshots.push('08_3d_zoom.png');

    // PHASE 4: Sintering State (Deep Think approach)
    console.log('Phase 4: Waiting for sintering...');
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${outputDir}/09_sintered.png` }); // Should show colored skirts
    metrics.screenshots.push('09_sintered.png');
    metrics.testPhases.push({ phase: 'sintered', timestamp: Date.now(), sinteringSpikes: metrics.sinteringSpikes });

    // FINAL METRICS (Pro approach)
    console.log('Collecting final metrics...');

    perfMetrics = await client.send('Performance.getMetrics');

    // Extract CDP metrics
    const jsHeap = perfMetrics.metrics.find(m => m.name === 'JSHeapUsedSize');
    const nodes = perfMetrics.metrics.find(m => m.name === 'Nodes');
    const layouts = perfMetrics.metrics.find(m => m.name === 'LayoutCount');
    const styles = perfMetrics.metrics.find(m => m.name === 'RecalcStyleCount');

    if (jsHeap) metrics.jsHeapSizeMB = Math.round(jsHeap.value / (1024 * 1024));
    if (nodes) metrics.domNodes = nodes.value;
    if (layouts) metrics.layoutCount = layouts.value;
    if (styles) metrics.styleRecalcCount = styles.value;

    // Extract memory from window.performance (Deep Think fallback)
    try {
        const jsHandle = await page.evaluateHandle(() => performance.memory);
        const mem = await jsHandle.jsonValue();
        if (mem && mem.usedJSHeapSize) {
            metrics.jsHeapSizeMB = Math.round(mem.usedJSHeapSize / (1024 * 1024));
        }
    } catch (e) {
        // performance.memory not available in all browsers
    }

    // Extract app stats if available
    try {
        const appStats = await page.evaluate(() => {
            if (window.pistonViewer) {
                return {
                    fps: window.pistonViewer.fpsState?.lastFPS || 0,
                    renderDistance: window.pistonViewer.renderSettings?.renderDistance,
                    tileCount: window.pistonViewer.tiles?.size || 0
                };
            }
            return null;
        });
        if (appStats) metrics.appStats = appStats;
    } catch (e) {
        console.log('pistonViewer stats not available');
    }

    // SAVE RESULTS
    const reportPath = `${outputDir}/report.json`;
    const finalReport = {
        status: 'COMPLETE', // Status is just complete, judgement happens outside
        summary: {
            memoryMB: metrics.jsHeapSizeMB,
            fps: metrics.appStats?.fps || 'N/A',
            errors: metrics.errors.length,
            spikes: metrics.movingSpikes + metrics.sinteringSpikes
        },
        rawMetrics: metrics
    };

    fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2));
    fs.writeFileSync(`${outputDir}/metrics.json`, JSON.stringify(metrics, null, 2));

    console.log('\n' + '='.repeat(40));
    console.log(`TEST COMPLETE`);
    console.log('='.repeat(40));
    console.log(`Memory: ${finalReport.summary.memoryMB}MB`);
    console.log(`Errors: ${finalReport.summary.errors}`);
    console.log(`Report: ${reportPath}`);
    console.log('='.repeat(40) + '\n');

    await browser.close();
    process.exit(0);
})();
