#include "main.h"

// ── Globals ───────────────────────────────────────────────────
byte mac[] = {0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0x05};

StarOTA::Server otaServer(OTA_TCP_PORT);

/**
 * The message this build prints. Prefer STAR_OTA_TEST_MESSAGE — the
 * library-wide flag that `firmware/tools/ota_upload.py --message` and the
 * Test-GUI's OTA tab both set — and fall back to this project's older
 * -DOTA_MESSAGE so the local ota_upload.py keeps working.
 */
static const char* currentMessage() {
    return StarOTA::testMessage()[0] != '\0' ? StarOTA::testMessage()
                                             : OTA_MESSAGE;
}
unsigned long lastPrintMillis = 0;
unsigned long bootTime = 0;

// ══════════════════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════════════════
void setup() {
    Serial.begin(115200);
    delay(1000);  // Give USB-CDC time to enumerate

    Serial.println("============================================");
    Serial.println("  ESP32-S3  Ethernet OTA Test Firmware");
    Serial.println("============================================");
    Serial.println();

    // ── LED ──────────────────────────────────────────────────
    pinMode(Pins.LED, OUTPUT);
    digitalWrite(Pins.LED, LOW);

    // ── Ethernet init (mirrors hotfire SensorHotfireCore pattern) ─
    Serial.println("[ETH] Initializing SPI for W5500...");
    Serial.print("  Pins -> SCLK=");
    Serial.print(Pins.ETH_SCLK);
    Serial.print("  MISO=");
    Serial.print(Pins.ETH_MISO);
    Serial.print("  MOSI=");
    Serial.print(Pins.ETH_MOSI);
    Serial.print("  CS=");
    Serial.println(Pins.ETH_CS);

    SPI.begin(Pins.ETH_SCLK, Pins.ETH_MISO, Pins.ETH_MOSI, Pins.ETH_CS);
    delay(ETHERNET_SPI_DELAY);
    Serial.println("[ETH] SPI.begin() done.");

    Ethernet.init(Pins.ETH_CS);
    delay(ETHERNET_INIT_DELAY);
    Serial.println("[ETH] Ethernet.init() done.");

    IPAddress ip = OTA_STATIC_IP;
    IPAddress gateway = OTA_GATEWAY;
    IPAddress subnet = OTA_SUBNET;
    IPAddress dns = OTA_DNS;

    Ethernet.begin(mac, ip, dns, gateway, subnet);
    delay(ETHERNET_BEGIN_DELAY);

    Serial.print("[ETH] Ethernet.begin() done.  IP = ");
    Serial.println(Ethernet.localIP());

    if (Ethernet.localIP() == IPAddress(0, 0, 0, 0)) {
        Serial.println(
            "[ETH] WARNING: IP is 0.0.0.0 — check cable / W5500 wiring!");
    }

    // ── OTA TCP server ──────────────────────────────────────
    otaServer.begin();
    Serial.println();

    // ── Ready ────────────────────────────────────────────────
    Serial.println("[MAIN] Setup complete. Entering main loop.");
    Serial.print("[MAIN] Current firmware message: \"");
    Serial.print(currentMessage());
    Serial.println("\"");
    Serial.println();

    bootTime = millis();
    lastPrintMillis = 0;  // Force immediate first print
}

// ══════════════════════════════════════════════════════════════
//  LOOP
// ══════════════════════════════════════════════════════════════
void loop() {
    // ── 1. Non-blocking OTA check ────────────────────────────
    // Blocks only while a transfer is actually running, and never returns on
    // success — the board reboots into the new image.
    otaServer.poll();

    // ── 2. Periodic serial message ───────────────────────────
    unsigned long now = millis();
    if (now - lastPrintMillis >= PRINT_INTERVAL_MS) {
        lastPrintMillis = now;

        unsigned long uptime = (now - bootTime) / 1000;
        unsigned long mins = uptime / 60;
        unsigned long secs = uptime % 60;

        Serial.print("[MSG] ");
        Serial.print(currentMessage());
        Serial.print("  |  uptime ");
        Serial.print(mins);
        Serial.print("m ");
        Serial.print(secs);
        Serial.print("s  |  IP ");
        Serial.println(Ethernet.localIP());

        // Blink LED briefly to show life
        digitalWrite(Pins.LED, HIGH);
        delay(50);
        digitalWrite(Pins.LED, LOW);
    }

    delay(10);  // Small yield
}
