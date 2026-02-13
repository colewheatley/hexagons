#!/bin/bash

# 🧇 Waffle Iron Overnight Super-Bake & S3 Sync
# This script runs the full geographic expansion and uploads tiles live to wheatley.cloud

# Ensure we are in the project root
cd "$(dirname "$0")/.."

echo "--------------------------------------------------"
echo "🚀 Starting PowFinder Global Bake & S3 Sync"
echo "Bucket: wheatley.cloud"
echo "Time: $(date)"
echo "--------------------------------------------------"

# Check for AWS CLI
if ! command -v aws &> /dev/null; then
    echo "❌ Error: AWS CLI not found. Please install it first."
    exit 1
fi

# Run the bake
# We use stdbuf to ensure python output isn't buffered so we can tail the log
python3 -u hex_backend/waffle_iron.py 2>&1 | tee bake_log_$(date +%Y%m%d_%H%M%S).log

echo "--------------------------------------------------"
echo "✅ Bake Complete."
echo "Check the log file for details."
echo "--------------------------------------------------"
