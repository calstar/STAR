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

## Motor GUI (`motor_gui.py`)

Switches the `Motor_Testing` board's 4-20 mA driver on and off over Ethernet.
Start heartbeats, wait for "Board: ACTIVE", then use ON/OFF. It sends
SERVER_HEARTBEAT every 500 ms and ACTUATOR_COMMAND (actuator_id 1) to UDP 5005,
and shows the board's BOARD_HEARTBEAT from UDP 5006.

```bash
pip install -r requirements.txt
python motor_gui.py                   # or: --ip 192.168.2.71
```

Give your computer an address on the board's subnet (e.g. 192.168.2.20/24).
The board turns the motor off 5 s after heartbeats stop, so stopping them or
closing the window stops the motor.

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
