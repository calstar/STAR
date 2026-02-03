# UTL Directory - Shared Utilities

## Current Contents

### Elodin Protocol (Used by daq_comms)
- **`db.hpp`** - Elodin database protocol definitions (VTable, postcard encoding)
  - This is Elodin's protocol specification
  - Used by `daq_comms` for VTable registration

## Archived (FSW-Specific)

All FSW-specific utilities have been moved to `archive/utl_fsw/`:
- Math/linear algebra utilities (gradients, lapacke, basic_linalg, matrix_alg, eig_solve, random_variables)
- FSW-specific wrappers (Elodin.hpp, TCPSocket.hpp, matrix.hpp, quat_euler.hpp)
- FSW database config (dbConfig*.hpp)
- FSW-specific utilities (diablo_*.hpp, Utilities.h)

## Note

The new `daq_comms/` system:
- ✅ Uses `db.hpp` for Elodin protocol (VTable/postcard encoding)
- ✅ Uses its own `TCPClient` (not FSW's `TCPSocket`)
- ✅ Uses its own `ElodinClient` (not FSW's `Elodin.hpp`)
- ✅ Uses its own `MessageFactory` (not FSW's copy)
- ✅ Does NOT use any FSW-specific utilities
