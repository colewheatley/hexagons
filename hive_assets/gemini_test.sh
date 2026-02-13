#!/bin/bash
# Gemini Visual Test Runner
# Usage: ./gemini_test.sh [URL] [--prompt "optional question"]
# Spawns a Gemini sub-agent to run visual tests and analyze results

set -e

# Parse arguments
URL="${1:-https://wheatley.cloud/powfinder/hexagons/app/}"
ADDENDUM=""

# Check for --prompt flag
while [[ $# -gt 0 ]]; do
  case $1 in
    --prompt)
      ADDENDUM="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Setup output directory
OUTPUT_DIR="/Users/cole/dev/Hexagons/hive_assets/.test_results/test-$(date +%s)"
mkdir -p "$OUTPUT_DIR"

echo "=== Gemini Visual Test ==="
echo "Target: $URL"
echo "Output: $OUTPUT_DIR"
echo ""

# Build the base prompt
BASE_PROMPT="You are a multimodal agent analyzing screenshots from a 3D hexagonal terrain viewer (PowFinder Hexagons). 

EXPECTED BEHAVIOR:
- 3D hexagonal pistons should render as solid colored volumes (not wireframes)
- Colors represent elevation data (green=low, yellow/orange=mid, red=high)
- No z-fighting, flickering, or overlapping geometry artifacts
- Hexagons should have visible "skirts" on SE, S, SW edges
- Camera controls (zoom/pan) should work smoothly

Your task:
1. Run: node /Users/cole/dev/Hexagons/hive_assets/playwright_screenshots.js $URL $OUTPUT_DIR
2. Wait for completion
3. Analyze all screenshots in $OUTPUT_DIR
4. Check for visual bugs: z-fighting, missing geometry, black screens, wireframes, rendering artifacts
5. Read metrics.json for performance data
6. Answer concisely - you are a sub-agent in a feedback loop

You MAY use Playwright MCP if screenshots are insufficient to answer the question."

# Append user question if provided
if [[ -n "$ADDENDUM" ]]; then
  FULL_PROMPT="${BASE_PROMPT}

SPECIFIC QUESTION: ${ADDENDUM}

Provide a brief answer to the specific question above, then note any visual bugs found."
else
  FULL_PROMPT="${BASE_PROMPT}"
fi

echo "Spawning Gemini agent..."
gemini -y -m gemini-3-flash-preview -p "$FULL_PROMPT" --output-format text

echo ""
echo "=== Test Complete ==="
echo "Results: $OUTPUT_DIR/"
echo "Screenshots + metrics saved"
