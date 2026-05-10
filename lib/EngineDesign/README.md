# Pintle Injector Liquid Rocket Engine Design Pipeline

A comprehensive physics-based simulation and **multi-layer optimization pipeline** for LOX/RP-1 pintle injector rocket engines. Takes tank pressures as input and solves for chamber pressure, mass flow rates, thrust, and all performance parameters.

## Overview

**Core Principle:** Chamber pressure (Pc) is **never** an input — it's always **solved** from tank pressures by balancing supply and demand.

**Key Capabilities:**
- Full flow path simulation: tank → feed system → injector → combustion → nozzle → thrust
- Multi-layer optimization for complete engine design (geometry, pressure curves, thermal protection)
- Time-varying analysis with ablative recession tracking
- Stability analysis (chugging, acoustic, feed-system coupling)
- Flight simulation validation via RocketPy integration

## Architecture

```mermaid
flowchart TB
    subgraph inputs [Inputs]
        TankP["Tank Pressures: LOX + RP-1"]
        Config["YAML Config: configs/default.yaml"]
    end

    subgraph core [Core Modules]
        Runner["PintleEngineRunner: engine/core/runner.py"]
        Solver["ChamberSolver: engine/core/chamber_solver.py"]
        CEA["CEA Cache: engine/pipeline/cea_cache.py"]
    end

    subgraph physics [Physics Models]
        Feed[Feed System Losses]
        Injector[Injector Flow]
        Spray[Spray Physics]
        Nozzle[Nozzle Thrust]
        Thermal["Thermal Protection: Ablative + Graphite"]
    end

    subgraph optimizer [Optimization Layers]
        L1["Layer 1: Static Optimization"]
        L2["Layer 2: Pressure Curves"]
        L3["Layer 3: Thermal Sizing"]
        L4["Layer 4: Flight Validation"]
    end

    subgraph control [Control System]
        DDP["Robust DDP Controller: engine/control/robust_ddp/"]
    end

    subgraph interfaces [User Interfaces]
        Backend["FastAPI Backend: backend/main.py"]
        Frontend["React Frontend: frontend/"]
    end

    subgraph outputs [Outputs]
        Thrust["Thrust, Isp, Pc"]
        Curves[Pressure Curves]
        Design["Optimized Design YAML"]
    end

    TankP --> Runner
    Config --> Runner
    Runner --> Solver
    Solver --> CEA
    Runner --> Feed
    Runner --> Injector
    Runner --> Spray
    Runner --> Nozzle
    Runner --> Thermal

    L1 --> L2
    L2 --> L3
    L3 --> L4

    Runner --> DDP
    DDP --> Runner

    Runner --> Thrust
    L4 --> Curves
    L4 --> Design

    Backend --> Runner
    Frontend --> Backend
```

## Multi-Layer Optimization Pipeline

The optimizer in `engine/optimizer/` runs 4 layers sequentially:

| Layer | Name | Purpose | Key File |
|-------|------|---------|----------|
| 1 | Static Optimization | Geometry + initial pressure curves, static hot-fire validation | `layers/layer1_static_optimization.py` |
| 2 | Pressure Curves | Time-series pressure curve optimization | `layers/layer2_pressure.py` |
| 3 | Thermal Sizing | Final ablative/graphite thickness optimization | `layers/layer3_thermal_protection.py` |
| 4 | Flight Validation | RocketPy trajectory simulation, tank fill iteration | `layers/layer4_flight_simulation.py` |

### Entry Point

The main orchestrator is `run_full_engine_optimization_with_flight_sim()` in:
```
engine/optimizer/main_optimizer.py
```

## Directory Structure

```
EngineDesign/
├── engine/                      # Main engine package
│   ├── core/                    # Core physics models
│   │   ├── runner.py            # Main pipeline orchestrator
│   │   ├── chamber_solver.py    # Pc solver (supply = demand)
│   │   ├── chamber_geometry.py  # Chamber sizing calculations
│   │   ├── nozzle.py            # Thrust calculation
│   │   ├── spray.py             # Spray physics (J, SMD, Weber)
│   │   ├── discharge.py         # Dynamic Cd model
│   │   ├── geometry.py          # Injector geometry
│   │   └── injectors/           # Injector type implementations
│   │
│   ├── pipeline/                # Pipeline infrastructure
│   │   ├── config_schemas.py    # Pydantic validation
│   │   ├── cea_cache.py         # CEA thermochemistry caching
│   │   ├── io.py                # Config loading/saving
│   │   ├── time_varying_solver.py
│   │   ├── thermal/             # Thermal protection models
│   │   │   ├── ablative_cooling.py
│   │   │   ├── graphite_cooling.py
│   │   │   └── regen_cooling.py
│   │   └── stability/           # Stability analysis
│   │       ├── analysis.py
│   │       └── coupling.py
│   │
│   ├── optimizer/               # Optimization layers
│   │   ├── main_optimizer.py    # Main orchestrator
│   │   ├── layers/              # Individual layer implementations
│   │   │   ├── layer1_static_optimization.py
│   │   │   ├── layer2_pressure.py
│   │   │   ├── layer3_thermal_protection.py
│   │   │   └── layer4_flight_simulation.py
│   │   └── views/               # UI components for optimizer
│   │
│   └── control/                 # Control system
│       └── robust_ddp/          # Robust DDP controller
│           ├── controller.py    # Main controller
│           ├── ddp_solver.py    # DDP optimization
│           ├── dynamics.py      # System dynamics
│           └── constraints.py   # Safety constraints
│
├── backend/                     # FastAPI backend
│   ├── main.py                  # FastAPI application entry point
│   ├── state.py                 # Application state management
│   └── routers/                  # API route handlers
│       ├── config.py            # Configuration endpoints
│       ├── evaluate.py          # Engine evaluation endpoints
│       ├── timeseries.py        # Time-series analysis endpoints
│       ├── flight.py            # Flight simulation endpoints
│       ├── geometry.py          # Geometry endpoints
│       ├── optimizer.py         # Optimization endpoints
│       └── control.py           # Control system endpoints
│
├── frontend/                    # React + Vite frontend
│   ├── src/                     # React source code
│   ├── package.json             # Node.js dependencies
│   └── vite.config.ts           # Vite configuration
│
├── copv/                        # COPV pressure calculations
│   ├── copv_solve.py
│   ├── blowdown_solver.py       # Coupled blowdown simulation
│   └── n2_Z_lookup.csv
│
├── configs/                     # Configuration files
│   └── default.yaml             # Base engine configuration
│
├── output/                      # Generated files (gitignored)
│   ├── logs/                    # Optimization logs
│   ├── plots/                   # Generated plots
│   └── cache/                   # CEA cache files
│
├── docs/                        # Documentation
│   ├── pipeline_status.md       # Implementation status
│   ├── quick_reference.md      # Quick reference guide
│   ├── layer_requirements.md    # Layer interface requirements
│   ├── optimizer_readme.md      # Optimizer documentation
│   ├── optimization_layers_readme.md
│   └── control/                 # Control system documentation
│       ├── README.md
│       ├── DDP_SOLVER.md
│       └── CONTROLLER_SUMMARY.md
│
├── scripts/                     # Utility scripts
│   ├── simple_example.py
│   ├── run_full_pipeline.py
│   └── pressure_sweep.py
│
├── tests/                       # Test suite
│   └── control/                 # Control system tests
│
├── dev.sh                       # Development startup script
├── README.md
├── QUICKSTART.md                # Quick start guide
├── STARTUP_GUIDE.md             # Detailed startup instructions
├── requirements.txt
└── .gitignore
```

## Quick Start

### Installation

**Python Backend:**
```bash
pip install -r requirements.txt
```

**Frontend (Optional, for web UI):**
```bash
cd frontend
npm install
```

**Dependencies:** numpy, scipy, pandas, matplotlib, pydantic, PyYAML, rocketcea, rocketpy, plotly, ezdxf, cma, CoolProp, fastapi, uvicorn, python-multipart

**Frontend Dependencies:** Node.js and npm required. See `frontend/package.json` for React/Vite dependencies.

### Running the Application

**Recommended: Development Script**
```bash
./dev.sh
```
This automatically starts both the FastAPI backend (http://localhost:8000) and React frontend (http://localhost:5173). The frontend provides an interactive web interface for engine design and optimization. See `STARTUP_GUIDE.md` for details and troubleshooting.

**Manual Startup (Alternative)**
If you prefer to start services manually:

Backend (FastAPI):
```bash
uvicorn backend.main:app --reload --port 8000
```

Frontend (React + Vite) - in a separate terminal:
```bash
cd frontend
npm install  # First time only
npm run dev
```

Then open http://localhost:5173 in your browser.

**Python API Only**
You can also use the engine directly via Python without the web interface (see Basic Usage below).

### Basic Usage

```python
from pathlib import Path
from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner

# Load configuration
config = load_config("configs/default.yaml")

# Initialize runner
runner = PintleEngineRunner(config)

# Evaluate at specific tank pressures
P_tank_O = 1305 * 6894.76  # psi to Pa
P_tank_F = 974 * 6894.76   # psi to Pa

results = runner.evaluate(P_tank_O, P_tank_F)

print(f"Thrust: {results['F']/1000:.2f} kN")
print(f"Chamber Pressure: {results['Pc']/6894.76:.1f} psi")
print(f"Mass Flow: {results['mdot_total']:.3f} kg/s")
print(f"Mixture Ratio: {results['MR']:.2f}")
```

### Web Application Features

The React frontend (started via `./dev.sh`) provides an interactive web interface with:

- Forward solver: Tank pressures → Performance
- Inverse solvers: Target thrust/O/F → Required tank pressures
- Full engine optimizer with multi-layer pipeline
- Time-series analysis and visualization
- Export optimized configurations
- Robust DDP control system integration
- Real-time performance monitoring

### Example Scripts

```bash
# Run full pipeline analysis
python scripts/run_full_pipeline.py

# Simple example
python scripts/simple_example.py

# Pressure sweep (2D grid)
python scripts/pressure_sweep.py
```

**For more detailed setup instructions, see:**
- `QUICKSTART.md` - Quick start guide for backend/frontend
- `STARTUP_GUIDE.md` - Detailed startup instructions and troubleshooting

## Configuration

Engine parameters are defined in YAML. Key sections of `configs/default.yaml`:

```yaml
fluids:
  oxidizer: { name: LOX, density: 1140.0, ... }
  fuel: { name: RP-1, density: 780.0, ... }

injector:
  type: pintle
  geometry:
    lox: { n_orifices: 12, d_orifice: 0.003, ... }
    fuel: { d_pintle_tip: 0.015, h_gap: 0.0005, ... }

feed_system:
  oxidizer: { K0: 2.0, ... }
  fuel: { K0: 2.0, ... }

combustion:
  cea: { oxName: LOX, fuelName: RP-1, ... }
  efficiency: { ... }

chamber:
  A_throat: 0.0005
  Lstar: 1.0
  ...

nozzle:
  expansion_ratio: 4.0
  ...

ablative_cooling:
  enabled: true
  initial_thickness: 0.008
  ...

graphite_insert:
  enabled: true
  initial_thickness: 0.005
  ...
```

## Key Features

### Robust DDP Control System

The project includes a robust Differential Dynamic Programming (DDP) controller for real-time engine control and optimization. Located in `engine/control/robust_ddp/`, this system provides:

- **Real-time control**: Optimal control trajectories for tank pressures
- **Safety constraints**: Hard constraints on chamber pressure, mixture ratio, and stability
- **Robustness**: Handles model uncertainty and disturbances
- **Feedforward + Feedback**: Combined control strategy for optimal performance

See `docs/control/` for detailed documentation on the control system architecture and usage.

### Backend API

The FastAPI backend (`backend/main.py`) provides RESTful endpoints for:

- Engine evaluation and performance analysis
- Time-series pressure curve generation
- Flight simulation integration
- Geometry optimization
- Control system integration
- Configuration management

API documentation available at http://localhost:8000/docs when the backend is running.

### Frontend Application

The React frontend (`frontend/`) provides an interactive web interface for:

- Real-time engine performance visualization
- Interactive parameter adjustment
- Optimization progress monitoring
- Results export and analysis
- Control system visualization

## Key Physics

### Chamber Solver
Root-finding: `supply(Pc) - demand(Pc) = 0`
- **Supply:** Mass flow from injectors (depends on P_tank - Pc)
- **Demand:** Mass flow required by combustion (depends on Pc, MR, c*)

### Discharge Coefficients
Dynamic model: `Cd(Re) = Cd_∞ - a_Re/√Re`

### Combustion Efficiency
L*-based: `η_c* = 1 - C × e^(-K×L*)`

### Nozzle Thrust
`F = ṁ × v_exit + (P_exit - P_ambient) × A_exit`

### Stability Analysis
- Chugging margin
- Acoustic modes
- Feed-system coupling
- Combined stability score (0-1)

## References

- Huzel & Huang: "Design of Liquid Propellant Rocket Engines"
- Sutton & Biblarz: "Rocket Propulsion Elements"
- Lefebvre: "Atomization and Sprays"

## Related Documentation

See the `docs/` folder for additional documentation:

**Core Documentation:**
- `docs/pipeline_status.md` - Detailed implementation status
- `docs/layer_requirements.md` - Layer interface requirements
- `docs/quick_reference.md` - Quick reference guide
- `docs/optimizer_readme.md` - Optimizer architecture and usage
- `docs/optimization_layers_readme.md` - Layer structure and responsibilities

**Control System Documentation:**
- `docs/control/README.md` - Control system overview
- `docs/control/DDP_SOLVER.md` - DDP solver implementation
- `docs/control/CONTROLLER_SUMMARY.md` - Controller architecture
- `docs/control/CONSTRAINTS.md` - Safety constraints
- `docs/control/ROBUSTNESS.md` - Robustness features

**Additional Guides:**
- `QUICKSTART.md` - Quick start for backend/frontend
- `STARTUP_GUIDE.md` - Detailed startup and troubleshooting
