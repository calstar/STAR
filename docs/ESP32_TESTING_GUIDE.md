# ESP32 PT Calibration Pipeline Testing Guide

This guide explains how to test the ESP32→Elodin pipeline with both **fake data** and **real hardware**.

## Quick Test (Fake Data)

Test the entire pipeline without ESP32 hardware:

```bash
cd shell
./test_esp32_pipeline.sh
```

This creates a 4-pane tmux session:
- **Pane 1**: Elodin database
- **Pane 2**: Fake ESP32 packet generator (simulates hardware)
- **Pane 3**: ESP32 PT streamer (reads packets, sends to DB)
- **Pane 4**: Elodin visualizer

### What You Should See:

**Fake ESP32 Generator:**
```
📊 [5s] Packets sent: 100 (20 packets/s, 200 records/s)
   Sample Ch2: raw=1234567, voltage=2.8685V
```

**ESP32 Streamer:**
```
📊 STREAMING STATISTICS (10s):
Total packets: 200 (20 packets/s)
Total records: 2000 (200 records/s)
Channels: 0=200 1=200 2=200 3=200 4=200 5=200 6=200 7=200 8=200 9=200
```

**Visualizer:**
Should show 10 PT channels with realistic pressure data.

## Real Hardware Test

Once you connect your ESP32:

```bash
cd shell
./quick_start.sh test_db
```

This uses `/dev/ttyACM0` by default. To use a different port:

```bash
# Edit quick_start.sh line 70:
tmux send-keys -t "$SESSION_NAME":0.1 "cd build && ./esp32_pt_streamer 127.0.0.1 $PORT /dev/ttyUSB0 2>&1 | tee $SENSOR_LOG" C-m
```

## Architecture

### Fake Data Pipeline:
```
fake_esp32_packet_gen → Named Pipe → esp32_pt_streamer → Elodin DB → Visualizer
   (generates Rec18)   /tmp/...pipe   (converts to PT)    (stores)   (displays)
```

### Real Hardware Pipeline:
```
ESP32 Hardware → USB Serial → esp32_pt_streamer → Elodin DB → Visualizer
  (Rec18 packets)  /dev/ttyACM0  (converts to PT)    (stores)   (displays)
```

## Packet Format

### ESP32PacketHeader (20 bytes):
```cpp
char     magic[4];        // "AD26"
uint8_t  version;         // 2
uint8_t  flags;           // 0x01 = timestamps present
uint16_t count;           // number of records (typically 10)
uint16_t failures;        // failed reads
uint32_t total_time_us;   // sweep duration
uint32_t packet_time_us;  // packet timestamp
```

### Rec18 Record (26 bytes per channel):
```cpp
uint8_t  ch;              // channel id (0-9)
uint8_t  ok;              // 1 = valid, 0 = failed
int32_t  raw;             // 24-bit ADC value
int32_t  sample_time;     // per-sample timestamp
uint32_t read_time_dur;   // ADC read duration
uint32_t conv_time_dur;   // ADC conversion time
```

### PT Message (sent to Elodin):
```
Field 0: timestamp (microseconds)
Field 1: sensor_id (channel 0-9)
Field 2: raw_voltage (from ADC) ← THIS IS WHAT YOU CALIBRATE!
Field 3: pt_location (channel number)
```

## Voltage Conversion

The fake generator simulates realistic PT sensor voltages:

```cpp
// Pressure range: 0-1000 PSI
// Voltage range: 0.5V - 4.5V (typical PT sensor)
// ADC: ADS1256, 24-bit, ±2.5V reference

int32_t raw_adc;           // From ESP32
double voltage = (raw_adc / 8388607.0) * 2.5 + 2.5;  // Convert to volts

// Example values:
// 0 PSI   → 0.5V → raw_adc = -6710886
// 500 PSI → 2.5V → raw_adc = 0
// 1000 PSI → 4.5V → raw_adc = 6710886
```

## Debugging

### Check if data is flowing:

```bash
# Watch database log
tail -f ~/.local/share/elodin/test_esp32_metadata/log/db_*.log

# Watch streamer stats
tail -f ~/.local/share/elodin/test_esp32_metadata/log/streamer_*.log

# Monitor named pipe
ls -lh /tmp/fake_esp32_pipe
```

### Verify packet structure:

```bash
# Dump raw packets from fake generator
cd build
./fake_esp32_packet_gen /tmp/test_packets &
hexdump -C /tmp/test_packets | head -20
```

Should see:
```
00000000  41 44 32 36 02 01 0a 00  00 00 ... |AD26............|
                ^^^^^ ^^^^^ ^^^^^
                magic vers  count
```

## Calibration Workflow

1. **Start test system**: `./test_esp32_pipeline.sh`
2. **Verify data in visualizer**: Check all 10 channels are streaming
3. **Record calibration data**: Use PT calibration tools
4. **Build calibration curves**: Use `PTCalibrationFramework`
5. **Apply calibration**: Convert raw voltage → pressure

## Next Steps

- [ ] Test with real ESP32 hardware
- [ ] Record calibration data at known pressures
- [ ] Build multi-point calibration curves
- [ ] Test environmental corrections (temp, humidity)
- [ ] Validate against reference sensors

## Troubleshooting

**Problem**: Named pipe blocks forever

**Solution**: Make sure both generator and streamer are running

---

**Problem**: No data in visualizer

**Solution**: Check that packet magic "AD26" is correct and version = 2

---

**Problem**: Wrong voltage values

**Solution**: Verify ADC reference voltage (2.5V default)

---

**Problem**: Streamer can't open /dev/ttyACM0

**Solution**: 
```bash
# Add user to dialout group
sudo usermod -a -G dialout $USER
# Log out and back in
```




