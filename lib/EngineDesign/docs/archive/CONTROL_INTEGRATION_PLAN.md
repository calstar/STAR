# Control Integration Plan: Thrust Control via Pressure Regulation

## Executive Summary

This document maps the existing pipeline that computes thrust from tank/feed pressures and vice versa, and provides a plan for integrating a thrust control system with controller state, step function, and solenoid driver outputs.

## 1. Thrust/Chamber Closure Computation Pipeline

### 1.1 Core Functions: Tank Pressures → Chamber Pressure → Thrust

#### **Primary Entry Point: `engine/core/runner.py`**
- **Class:** `PintleEngineRunner`
- **Method:** `evaluate(P_tank_O: float, P_tank_F: float, ...) -> Dict[str, Any]`
- **Inputs:**
  - `P_tank_O`: Oxidizer tank pressure [Pa]
  - `P_tank_F`: Fuel tank pressure [Pa]
  - `Pc_guess`: Optional initial guess for chamber pressure [Pa]
- **Outputs:**
  - `Pc`: Chamber pressure [Pa]
  - `F`: Thrust [N]
  - `mdot_O`, `mdot_F`: Mass flow rates [kg/s]
  - `MR`: Mixture ratio (O/F)
  - `Isp`: Specific impulse [s]
  - Full diagnostics dictionary

#### **Chamber Pressure Solver: `engine/core/chamber_solver.py`**
- **Class:** `ChamberSolver`
- **Method:** `solve(P_tank_O: float, P_tank_F: float, Pc_guess: float = None) -> Tuple[float, Dict[str, Any]]`
- **Inputs:**
  - `P_tank_O`: Oxidizer tank pressure [Pa]
  - `P_tank_F`: Fuel tank pressure [Pa]
  - `Pc_guess`: Optional initial guess [Pa]
- **Outputs:**
  - `Pc`: Solved chamber pressure [Pa]
  - `diagnostics`: Dict with mdot_O, mdot_F, MR, cstar_actual, Tc, gamma, R, etc.
- **Internal Flow:**
  1. Calls `engine/core/closure.py::flows()` to compute mass flows
  2. Solves residual: `supply(Pc) - demand(Pc) = 0`
  3. Uses `scipy.optimize.brentq` or `newton` for root finding

#### **Closure/Flow Calculation: `engine/core/closure.py`**
- **Function:** `flows(P_tank_O: float, P_tank_F: float, Pc: float, config: PintleEngineConfig) -> Tuple[float, float, Dict[str, Any]]`
- **Inputs:**
  - `P_tank_O`: Oxidizer tank pressure [Pa]
  - `P_tank_F`: Fuel tank pressure [Pa]
  - `Pc`: Chamber pressure [Pa] (guess being solved for)
  - `config`: Engine configuration
- **Outputs:**
  - `mdot_O`: Oxidizer mass flow [kg/s]
  - `mdot_F`: Fuel mass flow [kg/s]
  - `diagnostics`: Dict with spray diagnostics, pressure drops, etc.
- **Internal Flow:**
  1. Gets injector model from config (`get_injector_model()`)
  2. Calls `injector.solve(P_tank_O, P_tank_F, Pc)`
  3. Injector computes:
     - Feed losses: `P_tank → P_injector` (via `engine/pipeline/feed_loss.py::delta_p_feed()`)
     - Injector flow: `P_injector - Pc → mdot` (via discharge coefficients)
     - Spray constraints validation

#### **Thrust Calculation: `engine/core/nozzle.py`**
- **Function:** `calculate_thrust(Pc: float, MR: float, mdot_total: float, cea_cache: CEACache, config: PintleEngineConfig, Pa: float, ...) -> Dict[str, Any]`
- **Inputs:**
  - `Pc`: Chamber pressure [Pa]
  - `MR`: Mixture ratio (O/F)
  - `mdot_total`: Total mass flow [kg/s]
  - `cea_cache`: CEA cache for thermochemical properties
  - `config`: Engine configuration
  - `Pa`: Ambient pressure [Pa]
- **Outputs:**
  - `F`: Total thrust [N] = `F_momentum + F_pressure`
  - `F_momentum`: `mdot_total × v_exit`
  - `F_pressure`: `(P_exit - Pa) × A_exit`
  - `Isp`: Specific impulse [s]
  - `v_exit`, `P_exit`, `T_exit`, `M_exit`: Exit conditions
  - `Cf_actual`, `Cf_ideal`: Thrust coefficients

### 1.2 Inverse Problem: Target Thrust → Required Tank Pressures

**Current Status:** No dedicated inverse solver found. The system is designed for forward mode (tank pressures → thrust).

**Potential Approach:**
- Use `PintleEngineRunner.evaluate()` in an optimization loop
- Minimize `|F_actual - F_target|` by varying `P_tank_O` and `P_tank_F`
- Could use `scipy.optimize.minimize` or similar

### 1.3 Feed Pressure Calculation

#### **Feed Loss Model: `engine/pipeline/feed_loss.py`**
- **Function:** `delta_p_feed(mdot: float, rho: float, config: FeedSystemConfig, P_tank: float) -> float`
- **Inputs:**
  - `mdot`: Mass flow rate [kg/s]
  - `rho`: Fluid density [kg/m³]
  - `config`: Feed system configuration (K0, K1, d_inlet, etc.)
  - `P_tank`: Tank pressure [Pa] (for pressure-dependent K_eff)
- **Outputs:**
  - `delta_p`: Pressure loss [Pa]
- **Formula:** `Δp_feed = K_eff(P) × (ρ/2) × v²` where `K_eff(P) = K0 + K1 × φ(P)`

**Injector Pressures:**
- `P_injector_O = P_tank_O - delta_p_feed_O`
- `P_injector_F = P_tank_F - delta_p_feed_F`
- These are computed inside the injector solver (`engine/core/injectors/pintle.py::PintleInjector.solve()`)

## 2. Sensor Data Representation

### 2.1 Current State

**No explicit sensor data structures found.** The codebase uses:
- **Python dictionaries** for diagnostics and results
- **NumPy arrays** for time series data
- **No protobufs, message buses, or structured sensor formats**

### 2.2 Data Flow

**Diagnostics Dictionary Structure** (from `ChamberSolver.solve()`):
```python
diagnostics = {
    "Pc": float,                    # Chamber pressure [Pa]
    "mdot_O": float,                 # Oxidizer mass flow [kg/s]
    "mdot_F": float,                 # Fuel mass flow [kg/s]
    "mdot_total": float,             # Total mass flow [kg/s]
    "MR": float,                     # Mixture ratio (O/F)
    "cstar_actual": float,           # Actual characteristic velocity [m/s]
    "Tc": float,                     # Chamber temperature [K]
    "gamma": float,                  # Specific heat ratio
    "R": float,                      # Gas constant [J/(kg·K)]
    "P_injector_O": float,           # Injector pressure (LOX) [Pa]
    "P_injector_F": float,           # Injector pressure (Fuel) [Pa]
    "delta_p_feed_O": float,         # Feed loss (LOX) [Pa]
    "delta_p_feed_F": float,         # Feed loss (Fuel) [Pa]
    "spray_diagnostics": dict,       # Spray quality metrics
    "cooling": dict,                 # Cooling results
    "validation_results": list,      # Physics validation results
    # ... more fields
}
```

**Time Series Data** (from `PintleEngineRunner.evaluate_arrays_with_time()`):
- Returns dictionary with NumPy arrays for all metrics
- Keys: `"time"`, `"Pc"`, `"F"`, `"mdot_O"`, `"mdot_F"`, `"MR"`, etc.

### 2.3 Navigation State

**No navigation state found.** The codebase is focused on engine performance simulation, not flight dynamics.

**Flight simulation exists** in `ui/flight_sim.py` and `backend/routers/flight.py`, but it's separate from the engine physics pipeline.

## 3. Control Loop/Scheduler

### 3.1 Current Architecture

**No real-time control loop exists.** The system is:
- **Simulation/Design Tool:** Computes performance from given inputs
- **FastAPI Backend:** Async request/response model (`backend/main.py`)
- **Time Series Solver:** Processes arrays of time points, not real-time ticks

### 3.2 Time-Varying Solver

**Location:** `engine/pipeline/time_varying_solver.py`
- **Class:** `TimeVaryingCoupledSolver`
- **Method:** `solve_time_step(time: float, dt: float, P_tank_O: float, P_tank_F: float, previous_state: Optional[TimeVaryingState] = None) -> TimeVaryingState`
- **Tick Rate:** Not fixed - called with explicit `time` and `dt` parameters
- **Threading:** Single-threaded, synchronous Python execution

### 3.3 Backend API

**Location:** `backend/main.py`
- **Framework:** FastAPI (async/await)
- **Routers:**
  - `backend/routers/evaluate.py`: Single-point evaluation
  - `backend/routers/timeseries.py`: Time series evaluation
  - `backend/routers/flight.py`: Flight simulation
  - `backend/routers/optimizer.py`: Optimization endpoints
- **No control endpoints:** No real-time control, sensor reading, or actuator commands

## 4. Integration Plan

### 4.1 Controller State (Persistent Across Ticks)

**Recommended Location:** `engine/control/thrust_controller.py` (new file)

**Structure:**
```python
@dataclass
class ThrustControllerState:
    """Persistent controller state across ticks."""
    # Target
    F_target: float              # Target thrust [N]
    
    # History (for derivative/adaptive control)
    F_history: List[float]       # Recent thrust measurements
    P_tank_O_history: List[float]  # Recent tank pressure commands
    P_tank_F_history: List[float]  # Recent tank pressure commands
    time_history: List[float]    # Timestamps
    
    # Controller parameters
    Kp: float                    # Proportional gain
    Ki: float                    # Integral gain
    Kd: float                    # Derivative gain
    MR_target: float             # Target mixture ratio (O/F)
    
    # Limits
    P_tank_O_min: float          # Minimum LOX tank pressure [Pa]
    P_tank_O_max: float          # Maximum LOX tank pressure [Pa]
    P_tank_F_min: float          # Minimum fuel tank pressure [Pa]
    P_tank_F_max: float          # Maximum fuel tank pressure [Pa]
    
    # Integrator state
    integral_error: float        # Accumulated error for I term
    last_error: float            # Previous error for D term
    last_time: float            # Previous tick time [s]
    
    # Solver cache (for performance)
    runner: Optional[PintleEngineRunner] = None
    config: Optional[PintleEngineConfig] = None
```

**Initialization:**
- Create in main control loop or at system startup
- Load from config file or set defaults
- Initialize `runner` and `config` references

### 4.2 Controller Step Function

**Recommended Location:** `engine/control/thrust_controller.py`

**Function Signature:**
```python
def step(
    state: ThrustControllerState,
    F_measured: float,           # Current measured thrust [N]
    P_tank_O_current: float,     # Current LOX tank pressure [Pa]
    P_tank_F_current: float,     # Current fuel tank pressure [Pa]
    time: float,                 # Current time [s]
    sensor_data: Optional[Dict[str, Any]] = None  # Optional sensor diagnostics
) -> Tuple[float, float, Dict[str, Any]]:
    """
    Controller step function called each tick.
    
    Returns:
    -------
    P_tank_O_cmd: float          # Commanded LOX tank pressure [Pa]
    P_tank_F_cmd: float          # Commanded fuel tank pressure [Pa]
    diagnostics: dict            # Controller diagnostics
    """
```

**Algorithm:**
1. **Compute error:** `error = F_target - F_measured`
2. **Update history:** Append current measurements to history (with max length)
3. **PID Control:**
   - **P term:** `P_term = Kp × error`
   - **I term:** `I_term = Ki × integral_error` (with anti-windup)
   - **D term:** `D_term = Kd × (error - last_error) / dt`
   - **Total:** `u_total = P_term + I_term + D_term`
4. **Allocate to tank pressures:**
   - Maintain `MR_target` while adjusting total flow
   - `P_tank_O_cmd = P_tank_O_current + delta_P_O`
   - `P_tank_F_cmd = P_tank_F_current + delta_P_F`
   - Use `runner.evaluate()` to compute expected thrust from commands
5. **Apply limits:** Clamp to `[P_min, P_max]` ranges
6. **Update state:** Store error, time, integrator state
7. **Return:** Commands + diagnostics

**Alternative: Model-Based Control**
- Use `runner.evaluate()` to compute Jacobian: `∂F/∂P_tank_O` and `∂F/∂P_tank_F`
- Use Newton-Raphson or gradient descent to find `P_tank_O`, `P_tank_F` that yield `F_target`
- More accurate but computationally expensive

### 4.3 Output to Solenoid Drivers

**Recommended Location:** `engine/control/solenoid_driver.py` (new file)

**Current Status:** No solenoid driver interface exists. The codebase is simulation-only.

**Recommended Interface:**

```python
class SolenoidDriver:
    """Interface for solenoid valve control."""
    
    def __init__(self, config: SolenoidDriverConfig):
        self.config = config
        # Hardware-specific initialization (GPIO, PWM, serial, etc.)
    
    def set_pressure_regulator(
        self,
        channel: str,              # "LOX" or "FUEL"
        P_target: float,           # Target pressure [Pa]
        mode: str = "binary"        # "binary" or "PWM"
    ) -> bool:
        """
        Set pressure regulator via solenoid.
        
        For binary mode:
        - Open solenoid if P_current < P_target - deadband
        - Close solenoid if P_current > P_target + deadband
        
        For PWM mode:
        - Set duty cycle proportional to error: duty = K × (P_target - P_current)
        - Clamp to [0, 1]
        
        Returns:
        -------
        success: bool              # Whether command was sent successfully
        """
    
    def get_pressure_reading(self, channel: str) -> float:
        """Read current pressure from sensor [Pa]."""
    
    def emergency_shutdown(self) -> bool:
        """Close all solenoids immediately."""
```

**Integration Point:**
- Call `solenoid_driver.set_pressure_regulator("LOX", P_tank_O_cmd)` after controller step
- Call `solenoid_driver.set_pressure_regulator("FUEL", P_tank_F_cmd)` after controller step
- Read feedback: `P_tank_O_measured = solenoid_driver.get_pressure_reading("LOX")`

### 4.4 Main Control Loop

**Recommended Location:** `engine/control/control_loop.py` (new file)

**Structure:**
```python
class ThrustControlLoop:
    """Main control loop for thrust regulation."""
    
    def __init__(
        self,
        config: PintleEngineConfig,
        controller_config: ThrustControllerConfig,
        tick_rate: float = 100.0  # Hz
    ):
        self.config = config
        self.controller_state = ThrustControllerState(...)
        self.solenoid_driver = SolenoidDriver(...)
        self.runner = PintleEngineRunner(config)
        self.tick_rate = tick_rate
        self.running = False
    
    def start(self):
        """Start control loop in background thread."""
        self.running = True
        thread = threading.Thread(target=self._loop, daemon=True)
        thread.start()
    
    def _loop(self):
        """Main control loop (runs in background thread)."""
        dt = 1.0 / self.tick_rate
        t = 0.0
        
        while self.running:
            start_time = time.time()
            
            # 1. Read sensors
            P_tank_O_measured = self.solenoid_driver.get_pressure_reading("LOX")
            P_tank_F_measured = self.solenoid_driver.get_pressure_reading("FUEL")
            F_measured = self._read_thrust_sensor()  # Load cell or estimated
            
            # 2. Controller step
            P_tank_O_cmd, P_tank_F_cmd, diagnostics = step(
                self.controller_state,
                F_measured,
                P_tank_O_measured,
                P_tank_F_measured,
                t,
                sensor_data={...}
            )
            
            # 3. Send commands to solenoids
            self.solenoid_driver.set_pressure_regulator("LOX", P_tank_O_cmd)
            self.solenoid_driver.set_pressure_regulator("FUEL", P_tank_F_cmd)
            
            # 4. Logging (optional)
            self._log_tick(t, diagnostics)
            
            # 5. Sleep to maintain tick rate
            elapsed = time.time() - start_time
            sleep_time = max(0, dt - elapsed)
            time.sleep(sleep_time)
            t += dt
    
    def stop(self):
        """Stop control loop and close solenoids."""
        self.running = False
        self.solenoid_driver.emergency_shutdown()
```

**Alternative: Async/Await (if using FastAPI):**
- Use `asyncio` instead of threading
- Create endpoint: `POST /control/start` and `POST /control/stop`
- Use `asyncio.create_task()` for background loop

## 5. File Structure Summary

### Existing Files (No Changes Needed)
- `engine/core/closure.py` - Flow calculation
- `engine/core/chamber_solver.py` - Chamber pressure solver
- `engine/core/nozzle.py` - Thrust calculation
- `engine/core/runner.py` - Main pipeline orchestrator
- `engine/pipeline/feed_loss.py` - Feed pressure loss model

### New Files to Create
1. **`engine/control/thrust_controller.py`**
   - `ThrustControllerState` dataclass
   - `step()` function
   - PID or model-based control logic

2. **`engine/control/solenoid_driver.py`**
   - `SolenoidDriver` class
   - Hardware interface (GPIO, PWM, serial, etc.)
   - Binary/PWM command generation

3. **`engine/control/control_loop.py`**
   - `ThrustControlLoop` class
   - Main loop with tick rate control
   - Sensor reading and actuator command dispatch

4. **`engine/control/__init__.py`**
   - Package initialization

5. **`backend/routers/control.py`** (optional)
   - FastAPI endpoints for control:
     - `POST /control/start` - Start control loop
     - `POST /control/stop` - Stop control loop
     - `POST /control/set_target` - Set target thrust
     - `GET /control/status` - Get controller state

6. **`engine/pipeline/config_schemas.py`** (modify)
   - Add `ThrustControllerConfig` schema
   - Add `SolenoidDriverConfig` schema

## 6. Recommended Insertion Points

### 6.1 Controller State Initialization
- **Location:** System startup or control loop initialization
- **File:** `engine/control/control_loop.py::ThrustControlLoop.__init__()`
- **Action:** Create `ThrustControllerState` instance with config values

### 6.2 Controller Step Function Call
- **Location:** Main control loop tick
- **File:** `engine/control/control_loop.py::ThrustControlLoop._loop()`
- **Action:** Call `step()` after reading sensors, before sending commands
- **Frequency:** Every tick (e.g., 100 Hz)

### 6.3 Solenoid Driver Output
- **Location:** After controller step, before next tick
- **File:** `engine/control/control_loop.py::ThrustControlLoop._loop()`
- **Action:** Call `solenoid_driver.set_pressure_regulator()` for both LOX and FUEL
- **Timing:** Immediately after receiving commands from controller

### 6.4 Sensor Data Input
- **Location:** Beginning of each control loop tick
- **File:** `engine/control/control_loop.py::ThrustControlLoop._loop()`
- **Action:** Read pressure transducers and thrust sensor
- **Format:** Convert hardware readings to SI units (Pa, N)

### 6.5 Thrust Estimation (Alternative to Direct Measurement)
- **Location:** If no load cell available, estimate from chamber pressure
- **File:** `engine/control/control_loop.py::ThrustControlLoop._read_thrust_sensor()`
- **Action:** Use `runner.evaluate(P_tank_O_measured, P_tank_F_measured)` to compute expected thrust
- **Note:** Less accurate than direct measurement, but acceptable for feedforward control

## 7. Dependencies and Requirements

### 7.1 External Dependencies
- **Hardware Interface:** Depends on solenoid hardware (GPIO library, PWM library, serial, etc.)
- **Sensor Interface:** Depends on pressure transducer interface (ADC, I2C, SPI, etc.)
- **Threading/Async:** Python `threading` or `asyncio` for control loop

### 7.2 Configuration
- Controller gains (Kp, Ki, Kd)
- Tank pressure limits
- Target mixture ratio
- Tick rate
- Solenoid hardware configuration (GPIO pins, PWM channels, etc.)

## 8. Testing Strategy

### 8.1 Unit Tests
- Test `step()` function with known inputs/outputs
- Test PID controller with step response
- Test solenoid driver command generation

### 8.2 Integration Tests
- Test control loop with mock hardware
- Test end-to-end: sensor → controller → actuator
- Test emergency shutdown

### 8.3 Hardware-in-the-Loop (HITL)
- Connect to real solenoids and sensors
- Validate pressure regulation accuracy
- Validate thrust tracking performance

## 9. Notes and Considerations

1. **No Real-Time OS:** Current system is Python-based, not real-time. For hard real-time requirements, consider:
   - C/C++ extension for control loop
   - Real-time Linux kernel (PREEMPT_RT)
   - Separate microcontroller for low-level control

2. **Sensor Data Format:** Currently uses Python dicts. For production, consider:
   - Structured data classes (dataclasses, Pydantic models)
   - Message serialization (protobuf, MessagePack) for network communication
   - Time-series database for logging

3. **Control Algorithm:** PID is simple but may not be optimal. Consider:
   - Model predictive control (MPC) using `runner.evaluate()` as plant model
   - Adaptive control for varying engine conditions
   - Feedforward from target thrust to initial pressure estimate

4. **Safety:** Implement:
   - Emergency shutdown on fault detection
   - Pressure limit enforcement
   - Watchdog timer for control loop health

5. **Logging:** Add structured logging for:
   - Controller state at each tick
   - Sensor readings
   - Actuator commands
   - Performance metrics (settling time, overshoot, steady-state error)

