const { chromium } = require('playwright');

(async () => {
  console.log("Starting Simple Sniffer...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Sniff network requests
  page.on('request', request => {
    const url = request.url();
    if (url.includes('.webp') || url.includes('.jpg') || url.includes('.jpeg')) {
        // Filter out icons/assets
        if (!url.includes('Assets') && !url.includes('favicon')) {
            console.log(`[IMAGE]: ${url}`);
        }
    }
  });

  try {
    console.log("Navigating...");
    await page.goto('https://og.realitymaps.de/RealityMaps/', { waitUntil: 'networkidle' });
    
    console.log("Waiting 10s...");
    await page.waitForTimeout(10000);

    // Try to click the "Winter" button if possible.
    // Based on grep, there might be a button with text "Winter" or class "map-type".
    // We'll just try to click coordinates to interact.
    
    console.log("Waiting for rm3dApi...");
    try {
        const layerInfo = await page.evaluate(async () => {
            // Wait for API
            let attempts = 0;
            while (!window.rm3dApi && attempts < 20) {
                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }
            if (!window.rm3dApi) return "API NOT FOUND";

            const viewer = window.rm3dApi.viewer;
            if (!viewer) return "VIEWER NOT FOUND";

            // Extract useful info
            return {
                config: viewer.config,
                layers: viewer.mapStyle ? viewer.mapStyle.getLayers().map(l => ({id: l.id, name: l.name, props: l.props})) : "No MapStyle",
                imagery: viewer.scene ? viewer.scene.imageryLayers._layers.map(l => l.imageryProvider.url) : "No Scene"
            };
        });
        console.log("INJECTED INFO:", JSON.stringify(layerInfo, null, 2));
    } catch (e) {
        console.log("Injection failed:", e.message);
    }

    console.log("Simulating interaction...");
    await page.mouse.click(500, 500);
    await page.waitForTimeout(2000);
    await page.mouse.wheel(0, -500); // Zoom out?
    await page.waitForTimeout(5000);

    console.log("Done.");
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await browser.close();
  }
})();
