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

## Ball Valve GUI (`ball_valve_gui.py`)

Opens and closes the `Hotfire_Code/BallValve_Hotfire` board's motorized ball
valve over Ethernet and shows its 4-20 mA position readback. Start heartbeats,
wait for "Board: ACTIVE", then use OPEN/CLOSE. It sends SERVER_HEARTBEAT every
500 ms and ACTUATOR_COMMAND (actuator_id 1; 1 = open, 0 = closed) to UDP 5005,
and reads the board's BOARD_HEARTBEAT and SENSOR_DATA from UDP 5006.

```bash
pip install -r requirements.txt
python ball_valve_gui.py              # or: --ip 192.168.2.71
```

Give your computer an address on the board's subnet (e.g. 192.168.2.20/24).
The board **opens** the valve 5 s after heartbeats stop (its safe state), so
stopping them or closing the window opens it.

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
