# RealityMaps Winter Aerial Downloader (Investigation Results)

## The "Winter" Layer Reality
After exhaustive probing, scanning, and sniffing, we have determined the nature of the "Winter" layers served by RealityMaps.

*   **Layer Name:** `WinterHybridTexture` (Internal ID: `aerial-winter`)
*   **Base URL:** `https://three-d.b-cdn.net/Data/WinterHybridTexture`
*   **Format:** TMS (Inverted Y), JPEG.
*   **Content:** **Topographic Map** (White background, contour lines, roads).
    *   *Verified at Zoom 11 and Zoom 15.*
    *   *Despite being named "Aerial" in the code, the actual raster data is a stylized map.*

## Other Layers Found
| Layer Name | URL | Content | Notes |
| :--- | :--- | :--- | :--- |
| **winter3d** | `https://tms2.realitymaps.de/winter3d` | **Topographic Map** | Identical to `WinterHybridTexture`. Used as a fallback ("Ersatz II"). |
| **iso365** | `https://layers.b-cdn.net/iso365` | **DEM / Heightmap** | Grayscale elevation data (WEBP). Likely used for terrain shaping/shading. |
| **eox** | `https://three-d.b-cdn.net/Data/archive/eox` | **Sentinel-2** | Summer Satellite imagery (Green). Low resolution (10m). |
| **US** | `https://three-d.b-cdn.net/Data/archive/US` | **US Imagery?** | Found via sniffer, but content unverified/irrelevant for Alps. |

## Conclusion
There is **no public raster endpoint** for high-resolution Winter Aerial Photography (photos of snow). The "Winter" mode in the RealityMaps application likely relies on:
1.  The `WinterHybridTexture` (Topo Map) as the visual base.
2.  Procedural shading using `iso365` (DEM) to simulate 3D relief.
3.  Summer Aerials (not found in this probe) possibly tinted or not used in this specific "Winter" mode view.

The "Aerial Winter" layer defined in the code points to the Topographic map files.

## Artifacts
Sample tiles are stored in this directory for verification:
*   `HYBRID_winter_z15.jpg`: The Z15 tile from `WinterHybridTexture` (Confirmed Map).
*   `REAL_winter_aerial_z11.jpeg`: The Z11 tile from `winter` (Confirmed Map).
*   `eox_tile_z11.webp`: Summer Satellite.
*   `winter_aerial_z11.webp`: DEM.
