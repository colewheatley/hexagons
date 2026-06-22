#!/bin/bash
# Deploys the Freiger tour to wheatley.cloud/powfinder/hexagons/freiger/
#
# Layout:
#   /freiger/                      — landing page (phone picker)
#   /freiger/app/                  — web app (iPhone + desktop)
#   /freiger/hexagons-freiger-low.apk   — Android APK (all phones)
#   /freiger/hexagons-freiger-high.apk  — Android APK (12GB+ phones, lossless)
#
# Run from project root. Requires:
#   aws cli configured with wheatley.cloud bucket access
#   APKs already built (npm run apk:low && npm run apk:high)

set -e
cd "$(dirname "$0")/.."

S3="s3://wheatley.cloud/powfinder/hexagons/freiger"
REGION="eu-central-2"
APK_DIR="android/app/build/outputs/apk/debug"

echo "=================================================="
echo "🏔  Freiger Deploy → wheatley.cloud/powfinder/hexagons/freiger/"
echo "=================================================="

# --- 1. Build web variant ---
echo ""
echo "▶ Building web variant..."
node scripts/build-capacitor-web.mjs --variant=web

# --- 2. Upload web app to /freiger/app/ ---
echo ""
echo "▶ Uploading web app → $S3/app/"
aws s3 sync dist/ "$S3/app/" \
    --region "$REGION" \
    --exclude "*.DS_Store"

# --- 3. Upload landing page ---
echo ""
echo "▶ Uploading landing page → $S3/index.html"
aws s3 cp frontend/landing/freiger.html "$S3/index.html" \
    --region "$REGION" \
    --content-type "text/html; charset=utf-8"

# --- 4. Upload APKs ---
echo ""
echo "▶ Uploading APKs..."

LOW_APK="$APK_DIR/hexagons-freiger-low.apk"
HIGH_APK="$APK_DIR/hexagons-freiger-high.apk"

if [ -f "$LOW_APK" ]; then
    aws s3 cp "$LOW_APK" "$S3/hexagons-freiger-low.apk" \
        --region "$REGION" \
        --content-type "application/vnd.android.package-archive"
    echo "   ✓ low APK uploaded"
else
    echo "   ⚠ $LOW_APK not found — run: npm run apk:low"
fi

if [ -f "$HIGH_APK" ]; then
    aws s3 cp "$HIGH_APK" "$S3/hexagons-freiger-high.apk" \
        --region "$REGION" \
        --content-type "application/vnd.android.package-archive"
    echo "   ✓ high APK uploaded"
else
    echo "   ⚠ $HIGH_APK not found — run: npm run apk:high"
fi

echo ""
echo "=================================================="
echo "✅ Deploy complete."
echo "   https://wheatley.cloud/powfinder/hexagons/freiger/"
echo "=================================================="
