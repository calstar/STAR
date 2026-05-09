#!/usr/bin/env python3
"""Launcher for the combined sensor & actuator GUI. Run from test_guis/ or project root."""
import os
import sys
from pathlib import Path

# Ensure we can import combined_gui (same directory)
_here = Path(__file__).resolve().parent
sys.path.insert(0, str(_here))
os.chdir(_here)  # So relative paths in config resolve correctly

from combined_gui import main

if __name__ == '__main__':
    main()
