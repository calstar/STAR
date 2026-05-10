#!/usr/bin/env python3
"""
Test script for solved_chamber_plot function.

This script tests the new solved_chamber_plot function with realistic
geometry parameters from a typical optimizer output.
"""

import sys
import os
sys.path.insert(0, os.path.abspath('.'))

from engine.core.chamber_geometry_solver import solved_chamber_plot

# Test parameters (realistic values from optimizer)
# These are typical values that would come from layer1 optimizer
area_throat = 1.5e-4  # m² (150 mm²)
area_exit = 1.5e-3    # m² (1500 mm²) - expansion ratio ~10
volume_chamber = 5e-5  # m³ (50 cm³)
lstar = 1.27          # m (typical L*)
chamber_diameter = 0.0864  # m (3.4 inches)
length = 0.15         # m (150 mm total chamber length)

print("=" * 80)
print("Testing solved_chamber_plot function")
print("=" * 80)
print(f"\nInput Parameters:")
print(f"  Throat Area:      {area_throat*1e6:.2f} mm²")
print(f"  Exit Area:        {area_exit*1e6:.2f} mm²")
print(f"  Chamber Volume:   {volume_chamber*1e6:.2f} cm³")
print(f"  L*:               {lstar*1000:.2f} mm")
print(f"  Chamber Diameter: {chamber_diameter*1000:.2f} mm")
print(f"  Total Length:     {length*1000:.2f} mm")
print()

try:
    # Call the function
    chamber_pts, table_data, lengths = solved_chamber_plot(
        area_throat=area_throat,
        area_exit=area_exit,
        volume_chamber=volume_chamber,
        lstar=lstar,
        chamber_diameter=chamber_diameter,
        length=length,
        do_plot=True,
        color_segments=True,
        steps=200,
        export_dxf='chamber/test_solved_chamber.dxf'
    )
    
    print("✓ Function executed successfully!")
    print()
    print("Results:")
    print(f"  Generated {len(chamber_pts)} contour points")
    print(f"  Cylindrical Length: {lengths['cylindrical']*1000:.2f} mm")
    print(f"  Contraction Length: {lengths['contraction']*1000:.2f} mm")
    print(f"  Total Length:       {lengths['total']*1000:.2f} mm")
    print()
    print("Output files:")
    print("  - chamber/solved_chamber_contour.png")
    print("  - chamber/test_solved_chamber.dxf")
    print()
    
    # Print table data
    print("Geometry Table:")
    print("-" * 80)
    for row in table_data:
        if len(row) >= 5:
            print(f"  {row[0]:25s} {row[1]:15s} {row[2]:10s} {row[3]:15s} {row[4]:10s}")
    print("-" * 80)
    
    print("\n✓ Test completed successfully!")
    
except Exception as e:
    print(f"\n✗ Test failed with error:")
    print(f"  {type(e).__name__}: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
