#!/usr/bin/env python3
"""Quick test to print Gosper offsets for comparison with JavaScript."""

import coordinate_utility as coord_util

if __name__ == "__main__":
    print("Generating Gosper offsets at Level 5...")
    offsets = coord_util.generate_gosper_offsets(5, debug=True)
    print(f"\nDone. Generated {len(offsets)} offsets.")
