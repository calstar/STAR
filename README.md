# Diablo-FSW Sensor System

A distributed sensor data collection and visualization system for the Diablo Flight Software project, built on the Elodin time-series database. This system provides real-time telemetry collection and monitoring for rocket flight systems, simulating various sensor types for development and testing.

## Features

- **Flight-Ready Sensor Types**: Pressure/Temperature (PT), Thermocouple (TC), RTD, IMU (Accelerometer/Gyroscope), Barometer, GPS Position/Velocity
- **Autonomous Calibration System**: Self-learning Bayesian calibration that evolves from user input
- **Real-time Telemetry Streaming**: Continuous data generation with configurable frequencies for flight operations
- **Realistic Flight Data**: Stochastic sensor data with trends, drift, periodic variations, and noise modeling
- **Distributed Telemetry Architecture**: Ground station + Remote sensor nodes (Jetson/flight computers)
- **Development Testing**: Single-machine mode for FSW development and testing
- **Real-time Mission Monitoring**: Python-based data viewer with time-series plots
- **Flight-Grade Timing**: Proper time synchronization using CLOCK_MONOTONIC
- **Cross-Platform Support**: Works on Linux (flight computers) and macOS (development)
- **Mission-Critical Robustness**: Automatic backup, recovery, validation, and health monitoring

## Flight Software Architecture

```
┌─────────────────┐    TCP/IP     ┌──────────────────┐
│   Ground Station │◄─────────────►│  Flight Computer  │
│                 │    :2240      │  (Jetson/Linux)   │
│  ┌─────────────┐ │              │  ┌──────────────┐ │
│  │ Elodin DB   │ │              │  │ Sensor Gen.  │ │
│  └─────────────┘ │              │  └──────────────┘ │
│  ┌─────────────┐ │              └──────────────────┘
│  │ Data Viewer │ │
│  └─────────────┘ │
└─────────────────┘
```

## 🎓 Pressure Transducer Calibration System

### Overview

The system features an **autonomous, self-improving calibration framework** that learns from every calibration point and evolves its understanding of sensor behavior. The calibration system uses hierarchical Bayesian inference to share knowledge across all 16 pressure transducers.

### Key Capabilities

- 🤖 **Autonomous Learning**: System improves its prior knowledge automatically from user input
- 🔄 **Cross-Sensor Transfer**: Calibrating one PT improves estimates for all PTs
- 📊 **Uncertainty Quantification**: Full posterior distributions, not just point estimates
- 🎯 **Zero-Point Extrapolation**: Single zero-point calibration enables full-range operation
- 🛡️ **Mission-Critical Robustness**: Automatic backup, validation, and recovery
- 🚀 **Launch-Day Ready**: Minimal calibration input required on launch day

### Calibration System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    AUTONOMOUS CALIBRATION SYSTEM                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    Population Prior (μ_pop, Σ_pop)                 │  │
│  │   Accumulated knowledge from ALL sensors, ALL test sessions        │  │
│  │   Confidence grows with each calibration (0.25 → 0.92)             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              ↕                                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐      ┌────────────┐    │
│  │   PT #1    │  │   PT #2    │  │   PT #3    │ ...  │   PT #16   │    │
│  │ θ₁, Σ₁     │  │ θ₂, Σ₂     │  │ θ₃, Σ₃     │      │ θ₁₆, Σ₁₆   │    │
│  │ quality:0.8│  │ quality:0.9│  │ quality:0.3│      │ quality:0.6│    │
│  └────────────┘  └────────────┘  └────────────┘      └────────────┘    │
│         ↑               ↑               ↑                     ↑           │
│         └───────────────┴───────────────┴─────────────────────┘          │
│                    Empirical Bayes Update                                │
│              (All sensors contribute to population)                      │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │              Autonomous Learning Engine                            │  │
│  │  • Online Bayesian learner per sensor                              │  │
│  │  • Active learning agent (requests calibration when needed)        │  │
│  │  • Drift detector (monitors parameter evolution)                   │  │
│  │  • Prior evolution (continuous improvement)                        │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                   Robustness Features                              │  │
│  │  • Automatic backup (every 60s)                                    │  │
│  │  • Validation (voltage, pressure, coefficients)                    │  │
│  │  • Health monitoring (system status tracking)                      │  │
│  │  • Anomaly detection (outlier rejection)                           │  │
│  │  • Auto-recovery (from backup on failure)                          │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘

USER INPUT                        SYSTEM LEARNS                    BENEFITS
    ↓                                  ↓                               ↓
"PT2 = 500 PSI"  ────────────→  Update θ₂        ──────────→  PT2 more accurate
    │                             Update μ_pop    ──────────→  All PTs improve
    │                             Evolve prior    ──────────→  Future sessions better
    │                             Save knowledge  ──────────→  Persistent learning
    └──────────────────────────→  Propagate      ──────────→  PT1,3,4...16 benefit NOW
```

### System Workflow

#### 1️⃣ **Startup (Pre-Mission Testing)**

```bash
cd scripts
python3 start_calibration_system.py --mode test
```

**What happens:**
- System loads population prior from all previous test sessions
- Each PT initialized with shared knowledge from 100+ past calibrations
- Autonomous learning engine activates
- Validation and health monitoring begin

**User sees:**
```
🛡️  Robustness Manager active: mode=test
🤖 Autonomous Learning Engine active
✅ Loaded population prior (strength=125.6)
✅ Loaded learned prior (confidence=0.85)
```

#### 2️⃣ **User Provides Periodic Calibration**

**User action:** Connects PTs to known pressure source, inputs value

```python
# Example: PT2 at 500 PSI
Channel: PT2
Pressure: 500 PSI
Voltage: 2.50V (automatically captured)
```

**System response:**
1. **Validates input** (robustness module checks for sanity)
2. **Updates PT2 calibration** (Bayesian posterior update)
3. **Computes quality score** (how good is this calibration)
4. **Evolves population prior** (empirical Bayes update using all sensors)
5. **Propagates knowledge** (all other PTs benefit from shared prior)
6. **Saves learned knowledge** (persists for next session)

**User sees:**
```
✅ PT2 calibration added: quality=0.85, total_cal=23
🤖 Autonomous engine updated from PT2 calibration
💾 Saved evolved prior (confidence=0.87)
🌐 Knowledge propagated to 15 other PTs
```

#### 3️⃣ **Zero-Point Calibration (Special Case)**

When user provides a zero-point (pressure < 10 PSI):

```python
# Example: All PTs at atmospheric (0 PSI)
Channel: PT2
Pressure: 0 PSI
```

**System automatically:**
1. Updates PT2 with infinite precision (human input is ground truth)
2. **Propagates zero-point to ALL other PTs** using their current voltages
3. Establishes common reference point for entire sensor array

**User sees:**
```
🎯 ZERO-POINT CALIBRATION detected for PT2 at 0.0 PSI
🌐 Propagating to all other PTs...
  ✓ Propagated to PT1 at 0.05V
  ✓ Propagated to PT3 at 0.06V
  ... (all 15 other PTs)
✅ Zero-point calibration propagated to 15 PTs
```

#### 4️⃣ **Autonomous Prediction and Monitoring**

System continuously makes predictions with uncertainty:

```python
# For each PT, every 100ms:
pressure, uncertainty = predict(voltage)

# If uncertainty is high or calibration is stale:
if uncertainty > 50 PSI or time_since_calibration > 1 hour:
    # System requests calibration
    📝 PT5 calibration recommended
    Reason: high uncertainty (75.2 PSI); stale calibration (1.2h)
    Urgency: 0.65
    Expected range: 450-600 PSI
```

**User can:**
- Ignore request if not feasible
- Provide calibration when convenient
- System adapts based on user response

#### 5️⃣ **System Evolution Over Multiple Sessions**

**Session 1** (Week 1):
- 5 calibration points on PT2, 3 on PT5
- Prior confidence: 0.25
- Other PTs accuracy: ~30% error

**Session 2** (Week 2):
- 7 calibration points across different PTs
- Prior confidence: 0.52 (improved!)
- Other PTs accuracy: ~12% error

**Session 5** (Week 5):
- 60 total calibration points across all sessions
- Prior confidence: 0.85 (strong prior!)
- New PT with zero-point only: ~3% error

**Session 10** (Pre-Launch):
- 150+ accumulated calibration points
- Prior confidence: 0.92 (very strong!)
- **Launch ready**: Single zero-point gives <2% error across full range

#### 6️⃣ **Launch Day Operation**

```bash
cd scripts
python3 start_calibration_system.py --mode flight
```

**Critical difference:**
- **Consensus DISABLED**: Each PT measures independently
- **Measurements independent**: PT2 can read 500 PSI while PT3 reads 800 PSI
- **Calibration still shared**: Population prior still used for all PTs

**Launch day workflow:**
1. User provides **one zero-point calibration** on **one PT**
2. System propagates to all PTs
3. Full-range operation (0-1000 PSI) with <2% error
4. System monitors health and requests calibration only if critical

### Calibration Modes

| Mode | Consensus | Use Case | Calibration Requests |
|------|-----------|----------|---------------------|
| **TEST** | ✅ Enabled | Ground testing, all PTs on common manifold | Active learning enabled |
| **CALIBRATION** | ✅ Enabled | Dedicated calibration sessions | Active learning enabled |
| **FLIGHT** | ❌ Disabled | Mission operation, PTs at different pressures | Emergency only |
| **SAFE** | ❌ Disabled | Fallback mode with minimal features | Disabled |

### What Gets Shared vs. Independent

| Quantity | Shared? | Explanation |
|----------|---------|-------------|
| Population prior μ_pop | ✅ Yes | All PTs learn from this |
| Calibration parameters θⱼ | ✅ Correlated | Via shared prior |
| Voltage readings vⱼ(t) | ❌ No | Each PT reads its own voltage |
| Pressure predictions p̂ⱼ(t) | ❌ No (flight) | Independent in flight mode |
|  | ✅ Yes (test) | Consensus in test mode only |

### Command Reference

```bash
# Test mode (normal operation)
python3 start_calibration_system.py --mode test

# Calibration mode (dedicated calibration session)
python3 start_calibration_system.py --mode calibration

# Flight mode (with pre-flight checklist)
python3 start_calibration_system.py --mode flight

# Direct launch (skip checks - not recommended)
python3 channel_plotter.py

# Run robustness tests
python3 test_robustness_system.py

# Demo autonomous learning
python3 autonomous_calibration_engine.py
```

### Files and Persistence

**Calibration Data:**
- `population_prior.json` - Accumulated knowledge from all sessions
- `learned_prior.json` - Autonomous engine's evolved prior
- `calibration_pt*.json` - Individual PT calibration states
- `system_config.json` - Current system configuration

**Backups:**
- `calibration_backups/` - Automatic timestamped backups (every 60 seconds)
- Keeps last 10 backups automatically
- Use for disaster recovery

**Logs:**
- `calibration_logs/health_log_YYYYMMDD.log` - Daily health logs
- Tracks all calibration events, errors, warnings

### Key Metrics to Monitor

1. **Prior Confidence** (0-1): How confident system is in population prior
   - <0.5: Weak prior, needs more calibration
   - 0.5-0.8: Moderate prior, reasonable extrapolation
   - >0.8: Strong prior, mission-ready

2. **Effective Sample Size**: Virtual number of calibration points
   - Grows with each calibration
   - Slowly decays (forgetting factor)
   - Target: >50 for launch

3. **Drift Rate**: Parameter change per second
   - <1e-6: Very stable
   - 1e-6 to 1e-4: Normal aging
   - >1e-4: Rapid drift, investigate

4. **Sensor Quality** (0-1): How good each PT's calibration is
   - <0.5: Poor calibration, needs attention
   - 0.5-0.8: Good calibration
   - >0.8: Excellent calibration

### Mathematical Foundation

The system uses a **three-level hierarchical Bayesian model**:

```
Level 1 (Population): μ_pop, Σ_pop ~ Prior
                      ↓
Level 2 (Individual): θⱼ | μ_pop ~ N(μ_pop, Σ_pop)
                      ↓
Level 3 (Measurement): pⱼᵢ | θⱼ ~ N(φᵀθⱼ, σ²)
```

**Key insight**: Calibrating PT #2 updates μ_pop, which improves the prior for ALL other PTs.

### How System Becomes Smarter

**Example: Progressive Learning Over 10 Test Sessions**

| Session | Calibrations | Prior Conf. | Zero-Point Error | Notes |
|---------|-------------|-------------|------------------|-------|
| 1 | PT2: 5 pts | 0.15 | 35% | Weak prior, high uncertainty |
| 2 | PT5: 4 pts | 0.28 | 25% | Learning typical sensitivity |
| 3 | PT2,3,5: 8 pts | 0.42 | 18% | Cross-sensor knowledge building |
| 5 | Various: 25 pts | 0.65 | 10% | Moderate prior strength |
| 7 | Various: 50 pts | 0.78 | 6% | Strong prior emerging |
| 10 | Various: 120 pts | 0.92 | **1.8%** | **Mission ready!** |

**Key observation**: After session 10, providing just a zero-point on launch day gives <2% error across full 0-1000 PSI range!

### Real-World Example

**Scenario**: Testing rocket engine with 16 PTs measuring tank, feed lines, and chamber pressures.

**Week 1-4 (Ground Testing)**:
```
Day 1:  Calibrate PT2,3,5 (tank sensors) → 15 calibration points
        System: "Prior confidence = 0.35"
        
Day 3:  Calibrate PT8,9 (feed line sensors) → 8 calibration points  
        System: "Prior confidence = 0.51" (improved!)
        
Day 7:  Calibrate PT12,13 (chamber sensors) → 12 calibration points
        System: "Prior confidence = 0.68" (good prior!)
        
Day 14: Spot-check PT1 (new sensor) with zero-point only
        Result: 8% error across range (acceptable with weak PT1 calibration)
        
Day 21: Multiple calibration sessions across all PTs
        System: "Prior confidence = 0.85" (strong!)
```

**Day 28 (Launch Day)**:
```
08:00 - Connect all PTs, open system in FLIGHT mode
08:15 - Provide zero-point: "All PTs at 0 PSI"
        System propagates to all 16 PTs
08:20 - Begin pressurization
        PT2: 0→100→300→500→800 PSI (all within 2% of reference)
        PT5: 0→100→300→500→800 PSI (all within 2% of reference)
        PT12: 0→100→300→700→1000 PSI (chamber, all within 2%)
08:45 - LAUNCH ✅
        All PT readings accurate, no recalibration needed!
```

### Visualizing System State

The GUI provides real-time visibility into system intelligence:

```
┌─────────────────────────────────────────────────────────┐
│ PT Channel: PT2                                         │
├─────────────────────────────────────────────────────────┤
│ Current: 487.3 ± 3.2 PSI                                │
│ Voltage: 2.435 V                                        │
│ Calibration Points: 8                                   │
│ Quality: 0.87 (EXCELLENT)                               │
│ Autonomy: 0.82 (HIGH)                                   │
│                                                          │
│ Population Prior Status:                                │
│   Confidence: 0.89 (STRONG)                             │
│   Effective Sample Size: 87.3                           │
│   Update Count: 156                                     │
│   Drift Rate: 2.3e-7 /s (STABLE)                        │
│                                                          │
│ Calibration Requests: None                              │
│   (System confident, no calibration needed)             │
└─────────────────────────────────────────────────────────┘
```

### Troubleshooting Calibration Issues

**Issue: "High uncertainty"**
- Cause: Insufficient calibration points
- Solution: Provide 3-5 calibration points across voltage range

**Issue: "Calibration not holding"**
- Cause: Harness changed, mounting torque changed
- Solution: System automatically inflates uncertainty; provide new zero-point

**Issue: "PT predictions unrealistic"**
- Cause: Corrupted calibration file or bad coefficients
- Solution: Clear calibration for that PT, or restore from backup

**Issue: "System not learning"**
- Cause: Quality scores low, updates rejected
- Solution: Check for voltage/pressure input errors, ensure stable readings

**Emergency Recovery:**
```bash
# Kill application
pkill -9 -f channel_plotter

# Restore from backup
cd scripts
python3 -c "from calibration_robustness import RobustnessManager; RobustnessManager().auto_recover()"

# Restart
python3 channel_plotter.py
```

## Quick Start

### **🚀 One-Command Launch (Recommended)**
```bash
cd shell
./quick_start.sh [db_name]
```
This launches a 3-pane tmux session with database, sensors, and visualizer.

### **🛑 Clean Shutdown**
```bash
cd shell
./shutdown_system.sh
```

### **⚙️ Prerequisites**

- C++20 compiler (GCC 10+ or Clang 12+)
- CMake 3.16+
- Python 3.8+
- Elodin database
- Linux (flight computers) or macOS (development)

### **📋 Advanced Setup**

1. **Build the system:**
   ```bash
   cd sensor_system
   mkdir build && cd build
   cmake ..
   make
   ```

2. **Start the database:**
   ```bash
   # Cross-platform compatible (works on both Linux and macOS):
   elodin-db run '[::]:2240' ~/.local/share/elodin/test_db
   ```

3. **Start sensor generators:**
   ```bash
   ./scripts/fake_sensor_generator 127.0.0.1 2240
   ```

4. **View data:**
   ```bash
   elodin
```

### Distributed Mode (Ground Station + Remote)

1. **On Ground Station (Laptop):**
   ```bash
   # Start database
   elodin-db run '[::]:2240' ~/.local/share/elodin/test_db
   
   # Start data viewer
   elodin
      ```

2. **On Remote Machine (Jetson):**
   ```bash
   # Build and run sensor generator
   ./scripts/fake_sensor_generator_remote <groundstation_ip> 2240
   ```

## Sensor Types and Frequencies

| Sensor | Frequency | Data Type | Description |
|--------|-----------|-----------|-------------|
| IMU | 100 Hz | Accelerometer + Gyroscope | 3-axis motion sensors with vibration simulation |
| PT | 10 Hz | Pressure + Temperature | Atmospheric pressure and temperature with weather trends |
| TC | 5 Hz | Temperature + Voltage | Thermocouple temperature measurement |
| RTD | 2 Hz | Temperature + Resistance | Resistance temperature detector |
| Barometer | 20 Hz | Pressure + Altitude + Temperature | Barometric pressure and altitude |
| GPS Position | 1 Hz | Latitude + Longitude + Altitude | GPS coordinates with circular motion simulation |
| GPS Velocity | 1 Hz | North + East + Up velocity | GPS velocity components |

## Configuration

### Sensor Configuration
Edit `config/config_base.toml` for local settings or `config/config_jetson.toml` for remote deployment.

### Ground Station Configuration
Edit `groundstation/config/config_groundstation.toml` for ground station settings.

## Data Visualization

The Python viewer provides:
- Real-time time-series plots for all sensor types
- Configurable time windows
- Data export capabilities
- Multiple plot types (line, scatter, etc.)

## Development

### Project Structure
```
sensor_system/
├── comms/           # Message definitions and communication
├── config/          # Configuration files
├── external/        # External dependencies (MessageFactory)
├── groundstation/   # Ground station components
├── scripts/         # Sensor generators and utilities
├── shell/           # Shell scripts for orchestration
└── utl/            # Utilities (Elodin, TCP, database config)
```

### Building
```bash
mkdir build && cd build
cmake ..
make
```

### Adding New Sensors
1. Create message definition in `comms/include/`
2. Add vtable schema in `utl/dbConfig.hpp`
3. Implement generator function in `scripts/fake_sensor_generator.cpp`
4. Add to main loop and thread management

## Troubleshooting

### Common Issues

1. **"Couldn't find anything..." in viewer**
   - Ensure database is running
   - Check that `cppGenerateDBConfig()` is called
   - Verify packet IDs match between `dbConfig.hpp` and sensor generator

2. **"BufferUnderflow" errors in database logs**
   - Data is being sent but format is incorrect
   - Check message serialization and packet structure
   - Ensure `flush_elodin()` is called after each message

3. **Connection refused**
   - Verify database is running on correct port
   - Check firewall settings for distributed mode
   - Ensure correct IP addresses in configuration

4. **Compilation errors**
   - Ensure C++20 support
   - Check all dependencies are installed
   - Verify CMake configuration

### Debug Mode
Run with verbose output:
```bash
RUST_LOG=debug elodin-db run '[::]:2240' ~/.local/share/elodin/test_db
```

## License

This project is based on the FSW (Flight Software) system and maintains compatibility with the Elodin database architecture.

## 📚 Documentation

### Calibration System Documentation

- **[Autonomous Calibration Guide](docs/AUTONOMOUS_CALIBRATION_SYSTEM.md)** - Complete autonomous learning system documentation
- **[Calibration Framework (LaTeX)](docs/PressureTransducerCalibrationFramework.tex)** - Mathematical theory and proofs
- **[PT Calibration Guide](docs/PT_CALIBRATION_GUIDE.md)** - Practical calibration procedures
- **[ESP32 Integration](docs/ESP32_INTEGRATION_GUIDE.md)** - Hardware integration guide

### System Documentation

- **[Development Guide](docs/DEVELOPMENT.md)** - Code formatting, CI/CD, and development guidelines
- **[FSW Documentation](docs/FSW_README.md)** - Flight Software system architecture and components
- **[Deployment Guide](docs/DEPLOYMENT.md)** - Production deployment instructions
- **[Quick Start Guide](docs/QUICK_START.md)** - Quick setup and getting started
- **[Message Types](docs/MESSAGE_TYPES_SUMMARY.md)** - Complete message type documentation
- **[Migration Guide](docs/MIGRATION_TO_DIABLO.md)** - Migration instructions for Diablo FSW

### Quick Reference Card

```
┌──────────────────────────────────────────────────────────────┐
│  CALIBRATION SYSTEM QUICK REFERENCE                          │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  MODES:                                                       │
│    TEST       → Consensus ON,  all features active           │
│    CALIBRATION → Consensus ON,  focused calibration          │
│    FLIGHT     → Consensus OFF, independent measurements      │
│                                                                │
│  USER INPUT:                                                  │
│    1. Select PT channel                                       │
│    2. Enter pressure (PSI)                                    │
│    3. Click "Add Calibration Point"                           │
│    → System learns automatically!                             │
│                                                                │
│  ZERO-POINT CALIBRATION:                                      │
│    • Provide pressure < 10 PSI on ANY PT                      │
│    → System propagates to ALL 16 PTs automatically           │
│    → Common reference established                             │
│                                                                │
│  WHAT SYSTEM LEARNS:                                          │
│    ✓ Typical sensitivity (PSI/V)                             │
│    ✓ Nonlinearity characteristics                            │
│    ✓ Environmental dependencies                              │
│    ✓ Sensor-to-sensor variations                             │
│    ✓ Drift patterns and aging                                │
│                                                                │
│  LAUNCH DAY:                                                  │
│    1. python3 start_calibration_system.py --mode flight      │
│    2. Provide ONE zero-point calibration                      │
│    3. System extrapolates full range (<2% error)             │
│    4. Launch with confidence! 🚀                              │
│                                                                │
│  EMERGENCY:                                                   │
│    • Backup files: calibration_backups/                      │
│    • Auto-recovery: RobustnessManager().auto_recover()       │
│    • Health logs: calibration_logs/                          │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

### How Prior Evolution Works

The system **learns from how it evolves**:

1. **User provides calibration** → System updates PT posterior
2. **System computes quality** → Scores calibration goodness (0-1)
3. **Empirical Bayes kicks in** → Pools all PT posteriors to estimate population
4. **Prior evolves** → μ_pop and Σ_pop updated based on ALL sensors
5. **Knowledge propagates** → Improved prior given to all PTs
6. **Saved to disk** → Next session starts with accumulated knowledge

**Analogy**: Like a teacher learning from many students:
- Each student (PT) solves problems (calibrations)
- Teacher observes all solutions and learns the "typical" approach (population prior)
- Teacher shares this knowledge with new students (uncalibrated PTs)
- Over many classes (sessions), teacher becomes expert (strong prior)

**Mathematical**: 
```
θⱼ ~ N(μ_pop, Σ_pop)  ← Individual PTs drawn from population

μ̂_pop = (1/M) Σⱼ θⱼ  ← Mean of all PT posteriors

Σ̂_pop = Var(θⱼ) + E[Σⱼ]  ← Between-sensor + within-sensor variance
```

The system **continuously refines** these estimates as more data arrives, with recent data weighted more heavily (forgetting factor).

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `./format.sh` to format your code
5. Test thoroughly
6. Submit a pull request

## Deployment

For production deployment:
1. Set up proper systemd services for database and sensor generators
2. Configure log rotation
3. Set up monitoring and alerting
4. Use proper security configurations for network access

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for detailed deployment instructions.
