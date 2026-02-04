# UTL Directory - Shared Utilities

## Current Contents

### Elodin Protocol (Used by daq_comms)
- **`db.hpp`** - Elodin database protocol definitions (VTable, postcard encoding)
  - This is Elodin's protocol specification
  - Used by `daq_comms` for VTable registration

### Linear Algebra and Control Analysis
- **`LinearAlgebra.hpp`** - Comprehensive linear algebra and control system analysis library
  - Matrix operations (LU, QR, SVD, Cholesky, Eigenvalue decomposition)
  - Control system analysis (controllability, observability, stability)
  - LQR/LQG solvers and Riccati equation solvers
  - Kalman filter utilities
  - System identification tools
  - Matrix properties and metrics
  - Optimization utilities (QP, LP)
  - Uses Eigen3 as backend

### Legacy Matrix Utilities
- **`matrix_alg.hpp`** - Basic matrix operations (legacy, consider using LinearAlgebra.hpp)

## Archived (FSW-Specific)

All FSW-specific utilities have been moved to `archive/utl_fsw/`:
- Math/linear algebra utilities (gradients, lapacke, basic_linalg, eig_solve, random_variables)
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

## Linear Algebra Usage Example

```cpp
#include "utl/LinearAlgebra.hpp"
using namespace linalg;

// Analyze matrix properties
MatrixXd A = ...;
auto props = MatrixUtils::analyze(A);
std::cout << "Rank: " << props.rank << std::endl;
std::cout << "Condition number: " << props.condition_number << std::endl;

// Control system analysis
MatrixXd B = ...;
MatrixXd C = ...;
auto analysis = ControlAnalysis::analyze(A, B, C);
std::cout << "Controllable: " << analysis.is_controllable << std::endl;
std::cout << "Observable: " << analysis.is_observable << std::endl;

// Solve LQR
MatrixXd Q = ...;
MatrixXd R = ...;
auto lqr = LQRSolver::solve(A, B, Q, R);
std::cout << "LQR gain matrix:\n" << lqr.K << std::endl;
```
