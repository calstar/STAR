/**
 * ValveEncoder — ball valve position board (AS5600 + ESP32-S3 + MAX3485)
 *
 * The board's job (from the Compute sheet):
 *   1. Read the encoder                     -> as5600.cpp
 *   2. Interpret that angle into a state    -> include/valve_state.h
 *   3. Send that data over RS-485           -> rs485_link.cpp,
 *                                              include/valve_protocol.h
 *
 * Pins come from firmware/common/valve_encoder_board_pins.h.
 * Build settings (valve ID, baud, stream/polled) from platformio.ini.
 *
 * USB console at 115200 baud (pio device monitor): type `h` for commands.
 * Calibrate once per valve: fully closed -> `c`, fully open -> `o`.
 */

#include <Arduino.h>
#include <Wire.h>

#include "as5600.h"
#include "board_config.h"
#include "calibration.h"
#include "rs485_link.h"
#include "valve_protocol.h"
#include "valve_state.h"

using cfg::pins::Pins;

static Rs485Link rs485(cfg::RS485_UART_NUM, Pins.RS485_TX, Pins.RS485_RX,
                       Pins.RS485_DE, Pins.RS485_RE_N);
static As5600 encoder(Wire);
static valve::Calibration cal;

static As5600Reading reading;
static uint32_t readingMs = 0;
static valve::State state = valve::State::UNKNOWN;
static uint8_t seq = 0;

static uint32_t lastReadMs = 0;
#ifdef RS485_MODE_STREAM
static uint32_t lastSendMs = 0;
#endif
static uint32_t lastPrintMs = 0;
static bool livePrint = true;

// ---------------------------------------------------------------------------
// Steps 1 + 2: read the encoder, classify
// ---------------------------------------------------------------------------

static void readEncoder() {
    reading = encoder.read();
    readingMs = millis();
    state = valve::classify(reading.raw_angle, reading.usable(), cal);
}

static uint8_t statusFlags() {
    using namespace valve_proto::StatusFlags;
    uint8_t f = 0;
    if (!reading.i2c_ok)
        f |= I2C_ERROR;
    if (reading.magnetDetected())
        f |= MAGNET_DETECTED;
    if (reading.magnetTooWeak())
        f |= MAGNET_TOO_WEAK;
    if (reading.magnetTooStrong())
        f |= MAGNET_TOO_STRONG;
    if (!cal.valid())
        f |= NOT_CALIBRATED;
    return f;
}

// ---------------------------------------------------------------------------
// Step 3: send over RS-485
// ---------------------------------------------------------------------------

static void sendStatus() {
    valve_proto::ValveStatus s;
    s.seq = seq++;
    s.state = static_cast<uint8_t>(state);
    s.flags = statusFlags();
    s.raw_angle = reading.raw_angle;
    s.uptime_ms = readingMs;

    uint8_t buf[valve_proto::MAX_FRAME];
    size_t n = valve_proto::encodeStatus(cfg::VALVE_ADDR, s, buf, sizeof(buf));
    if (n > 0)
        rs485.send(buf, n);
}

static void handleIncoming() {
    while (rs485.poll()) {
        const valve_proto::Frame& f = rs485.frame();
        // Only answer polls addressed to this valve. Frames for other valves
        // on a shared bus are ignored.
        if (f.type == static_cast<uint8_t>(valve_proto::MsgType::POLL) &&
            f.valve_id == cfg::VALVE_ADDR) {
            sendStatus();
        }
    }
}

// ---------------------------------------------------------------------------
// USB console
// ---------------------------------------------------------------------------

static void printStatus() {
    float deg = reading.raw_angle * (360.0f / valve::COUNTS_PER_REV);
    Serial.printf(
        "raw=%4u (%6.1f deg)  state=%-7s  travel=%5.1f%%  i2c=%s "
        "magnet=%s%s%s\n",
        reading.raw_angle, deg, valve::stateName(state),
        valve::travelPermille(reading.raw_angle, cal) / 10.0f,
        reading.i2c_ok ? "ok" : "FAIL", reading.magnetDetected() ? "yes" : "NO",
        reading.magnetTooWeak() ? " TOO-WEAK" : "",
        reading.magnetTooStrong() ? " TOO-STRONG" : "");
}

static void printCalibration() {
    Serial.printf(
        "calibration: closed=%s%u  open=%s%u  tolerance=%u counts "
        "(%.1f deg)  -> %s\n",
        cal.has_closed ? "" : "(unset)", cal.closed_raw,
        cal.has_open ? "" : "(unset)", cal.open_raw, cal.tolerance,
        cal.tolerance * 360.0f / valve::COUNTS_PER_REV,
        cal.valid() ? "VALID" : "NOT VALID");
}

static void printHelp() {
    Serial.println("commands (type, then Enter):");
    Serial.println("  h      this help");
    Serial.println("  s      print status once");
    Serial.println("  v      toggle live status printing");
    Serial.println("  d      AS5600 register dump");
    Serial.println("  c      save current position as CLOSED");
    Serial.println("  o      save current position as OPEN");
    Serial.println("  t <n>  set closed/open window to n degrees (e.g. t 5)");
    Serial.println("  k      show calibration");
    Serial.println("  x      erase calibration");
    Serial.println("  r      RS-485 link counters");
}

static void savePosition(bool closed) {
    readEncoder();
    if (!reading.usable()) {
        Serial.println(
            "NOT saved: encoder reading isn't usable (check "
            "magnet / I2C, `d` for details)");
        return;
    }
    if (closed) {
        cal.closed_raw = reading.raw_angle;
        cal.has_closed = true;
    } else {
        cal.open_raw = reading.raw_angle;
        cal.has_open = true;
    }
    bool ok = calibration::save(cal);
    Serial.printf("%s position = %u %s\n", closed ? "CLOSED" : "OPEN",
                  reading.raw_angle, ok ? "saved" : "SAVE FAILED");
    printCalibration();
    if (cal.has_closed && cal.has_open && !cal.valid())
        Serial.println(
            "warning: open and closed are too close together "
            "for the tolerance window");
}

static void runCommand(char* line) {
    switch (line[0]) {
        case 'h':
            printHelp();
            break;
        case 's':
            printStatus();
            break;
        case 'v':
            livePrint = !livePrint;
            Serial.printf("live printing %s\n", livePrint ? "on" : "off");
            break;
        case 'd':
            encoder.dumpDiagnostics(Serial);
            break;
        case 'c':
            savePosition(true);
            break;
        case 'o':
            savePosition(false);
            break;
        case 't': {
            float deg = atof(line + 1);
            // Below 0.5 deg the window rounds to a few counts or none, and
            // sensor noise alone would flicker the state.
            if (deg < 0.5f || deg > 30.0f) {
                Serial.println("usage: t <degrees>, between 0.5 and 30");
                break;
            }
            cal.tolerance = valve::degToCounts(deg);
            calibration::save(cal);
            printCalibration();
            break;
        }
        case 'k':
            printCalibration();
            break;
        case 'x':
            calibration::clear();
            calibration::load(cal, cfg::DEFAULT_TOLERANCE_DEG);
            Serial.println("calibration erased");
            break;
        case 'r':
            Serial.printf(
                "RS-485: id=%u baud=%lu mode=%s sent=%lu "
                "good_in=%lu bad_in=%lu\n",
                cfg::VALVE_ADDR, (unsigned long)cfg::RS485_BAUD_RATE,
#ifdef RS485_MODE_STREAM
                "STREAM",
#else
                "POLLED",
#endif
                (unsigned long)rs485.framesSent(),
                (unsigned long)rs485.goodFramesIn(),
                (unsigned long)rs485.badFramesIn());
            break;
        case '\0':
            break;
        default:
            Serial.println("unknown command, type h");
    }
}

static void handleConsole() {
    static char line[32];
    static size_t len = 0;
    while (Serial.available() > 0) {
        char ch = static_cast<char>(Serial.read());
        if (ch == '\r' || ch == '\n') {
            line[len] = '\0';
            runCommand(line);
            len = 0;
        } else if (len < sizeof(line) - 1) {
            line[len++] = ch;
        }
    }
}

// ---------------------------------------------------------------------------

void setup() {
    // Before anything else: transceiver to listen mode, so nothing we do
    // during startup can drive the RS-485 bus.
    rs485.beginPinsSafe();

    Serial.begin(115200);  // USB console (native USB, CDC on boot)
    uint32_t t0 = millis();
    while (!Serial && millis() - t0 < 2000) {
        delay(10);  // give a monitor a moment to attach; don't block forever
    }

    Serial.println();
    Serial.println("=== Valve Encoder Board ===");
    Serial.printf("valve id %u, RS-485 %lu baud on TX=%d RX=%d DE=%d /RE=%d\n",
                  cfg::VALVE_ADDR, (unsigned long)cfg::RS485_BAUD_RATE,
                  Pins.RS485_TX, Pins.RS485_RX, Pins.RS485_DE, Pins.RS485_RE_N);

    rs485.begin(cfg::RS485_BAUD_RATE);

    bool ok = encoder.begin(Pins.ENC_SDA, Pins.ENC_SCL, cfg::I2C_CLOCK_HZ);
    Serial.printf("AS5600 on SDA=%d SCL=%d: %s\n", Pins.ENC_SDA, Pins.ENC_SCL,
                  ok ? "ACK" : "NO ACK (check solder, pull-ups, 3.3 V)");
    if (ok)
        encoder.dumpDiagnostics(Serial);

    calibration::load(cal, cfg::DEFAULT_TOLERANCE_DEG);
    printCalibration();
    if (!cal.valid())
        Serial.println(
            "not calibrated: state will read UNKNOWN until you "
            "save CLOSED (c) and OPEN (o)");
    printHelp();
}

void loop() {
    uint32_t now = millis();

    if (now - lastReadMs >= cfg::ENCODER_READ_PERIOD_MS) {
        lastReadMs = now;
        readEncoder();
    }

#ifdef RS485_MODE_STREAM
    if (now - lastSendMs >= cfg::STATUS_SEND_PERIOD_MS) {
        lastSendMs = now;
        sendStatus();
    }
#endif
    handleIncoming();  // answers POLLs addressed to us (both modes)

    handleConsole();
    if (livePrint && now - lastPrintMs >= cfg::CONSOLE_PRINT_PERIOD_MS) {
        lastPrintMs = now;
        printStatus();
    }
}
