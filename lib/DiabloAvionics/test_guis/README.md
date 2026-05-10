# test_guis

GUI tools for DiabloAvionics sensor and actuator testing.

## Sense Testing GUI (`sense_testing_gui.py`)

GUI that receives BOARD_HEARTBEAT and SENSOR_DATA UDP packets, plots sensor voltage, tracks board status (heartbeat rate, state, connection), and can send server heartbeat, sensor config, and abort packets to boards.

```bash
pip install -r requirements.txt
python sense_testing_gui.py
```

Options:
- `-p`, `--port` — UDP listen port (default: 5006)
- `-r`, `--ref-voltage` — ADC reference voltage in V (default: 2.5)

## Combined GUI (`combined_gui/`)

Full sensor & actuator control GUI with PT calibration, state machine, and more.

```bash
pip install -r requirements.txt
python combined_gui/run.py
```

Or from the `combined_gui` directory:
```bash
cd combined_gui
python combined_gui.py
```

### Firmware

- **Actuator board** (ADC_Testing/Actuator_Testing): Listen on UDP 5005, send sensor data to PC on 5006
- **PT/sensor board**: Send SENSOR_DATA to PC IP on port 5006 (or configure in Settings)
