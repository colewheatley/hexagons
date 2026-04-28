#!/usr/bin/env python3
# @atlas: Command-line diagnostic script. Generates and prints Gosper curve coordinate offsets (specifically at recursion Level 5) by invoking the Python coordinate_utility matrix math. Crucial for verifying that the backend spatial logic matches the frontend visualization exactly.
"""Quick test to print Gosper offsets for comparison with JavaScript."""

import coordinate_utility as coord_util

if __name__ == "__main__":
    print("Generating Gosper offsets at Level 5...")
    offsets = coord_util.generate_gosper_offsets(5, debug=True)
    print(f"\nDone. Generated {len(offsets)} offsets.")
