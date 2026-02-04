# Archive Directory

This directory contains legacy files that are kept for reference but not used by the new `daq_comms/` system.

## Contents

### `shell/` - Legacy Shell Scripts
Legacy tmux-based orchestration scripts for the FSW system. Replaced by:
- `scripts/test_full_pipeline.sh` - New test script
- `scripts/run_simulated_stack.sh` - New stack launcher
- Nix-based workflow

### `utl/` - FSW-Specific Utilities
FSW-specific utility files that are not used by `daq_comms/`:
- `diablo_attitude_utils.hpp` - Attitude utilities for FSW
- `diablo_math_utils.hpp` - Math utilities for FSW
- `diablo_nav_utils.hpp` - Navigation utilities for FSW

These are kept because FSW still uses them, but `daq_comms/` does not depend on them.

## Note

The new `daq_comms/` system only uses:
- `utl/Elodin.hpp` - Elodin protocol helpers
- `utl/TCPSocket.hpp` - TCP socket wrapper
- `utl/db.hpp` - Database utilities (via ElodinClient)

All other utilities are FSW-specific and not used by the new system.
