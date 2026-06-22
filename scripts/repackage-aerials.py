#!/usr/bin/env python3
"""
Repackages the pruned Freiger aerial webps in dist/aerial_tiles/full/ for a build variant.

  web      — resize to 2048×2048, q=10  (fast streaming)
  apk-low  — resize to 2048×2048, q=85  (safe VRAM budget: ~175 MB for 28 tiles)
  apk-high — pass-through               (assumed re-baked at lossless quality)

Usage (called by build-capacitor-web.mjs):
  python3 scripts/repackage-aerials.py --variant apk-low --dir dist/aerial_tiles/full
"""
import argparse
import sys
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", required=True, choices=["web", "apk-low", "apk-high"])
    parser.add_argument("--dir", required=True)
    args = parser.parse_args()

    target_dir = Path(args.dir)
    webps = sorted(target_dir.glob("sector_*.webp"))

    if not webps:
        print(f"repackage-aerials: no sector_*.webp in {target_dir}", file=sys.stderr)
        sys.exit(1)

    if args.variant == "apk-high":
        print(f"repackage-aerials: apk-high pass-through ({len(webps)} files)")
        return

    try:
        from PIL import Image
    except ImportError:
        print("repackage-aerials: Pillow required — run: pip install Pillow", file=sys.stderr)
        sys.exit(1)

    target_px = 2048
    quality = 85 if args.variant == "apk-low" else 10
    print(f"repackage-aerials: {args.variant} → {target_px}px q={quality} ({len(webps)} tiles)")

    for path in webps:
        if path.stat().st_size == 0:
            print(f"  ⚠ skipping empty file: {path.name}")
            continue
        img = Image.open(path).convert("RGB")
        if img.size != (target_px, target_px):
            img = img.resize((target_px, target_px), Image.LANCZOS)
        img.save(path, "WEBP", quality=quality, method=6)
        print(f"  ✓ {path.name} ({img.size[0]}px)")

    print("repackage-aerials: done")

if __name__ == "__main__":
    main()
