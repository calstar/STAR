#include "main.h"

// ── Globals ───────────────────────────────────────────────────
byte mac[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0x05 };

EthernetServer otaServer(OTA_TCP_PORT);
unsigned long lastPrintMillis = 0;
unsigned long bootTime        = 0;

// ── Forward declarations ─────────────────────────────────────
void handleOTA(EthernetClient& client);

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
  Serial.print("  Pins -> SCLK="); Serial.print(Pins.ETH_SCLK);
  Serial.print("  MISO=");         Serial.print(Pins.ETH_MISO);
  Serial.print("  MOSI=");         Serial.print(Pins.ETH_MOSI);
  Serial.print("  CS=");           Serial.println(Pins.ETH_CS);

  SPI.begin(Pins.ETH_SCLK, Pins.ETH_MISO, Pins.ETH_MOSI, Pins.ETH_CS);
  delay(ETHERNET_SPI_DELAY);
  Serial.println("[ETH] SPI.begin() done.");

  Ethernet.init(Pins.ETH_CS);
  delay(ETHERNET_INIT_DELAY);
  Serial.println("[ETH] Ethernet.init() done.");

  IPAddress ip      = OTA_STATIC_IP;
  IPAddress gateway = OTA_GATEWAY;
  IPAddress subnet  = OTA_SUBNET;
  IPAddress dns     = OTA_DNS;

  Ethernet.begin(mac, ip, dns, gateway, subnet);
  delay(ETHERNET_BEGIN_DELAY);

  Serial.print("[ETH] Ethernet.begin() done.  IP = ");
  Serial.println(Ethernet.localIP());

  if (Ethernet.localIP() == IPAddress(0, 0, 0, 0)) {
    Serial.println("[ETH] WARNING: IP is 0.0.0.0 — check cable / W5500 wiring!");
  }

  // ── OTA TCP server ──────────────────────────────────────
  otaServer.begin();
  Serial.print("[OTA] TCP server listening on port ");
  Serial.println(OTA_TCP_PORT);
  Serial.println();

  // ── Ready ────────────────────────────────────────────────
  Serial.println("[MAIN] Setup complete. Entering main loop.");
  Serial.print("[MAIN] Current firmware message: \"");
  Serial.print(OTA_MESSAGE);
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
  EthernetClient client = otaServer.available();
  if (client) {
    Serial.println();
    Serial.println(">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>");
    Serial.print("[OTA] Incoming connection from ");
    Serial.print(client.remoteIP());
    Serial.print(":");
    Serial.println(client.remotePort());
    Serial.println(">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>");

    handleOTA(client);  // Blocking during firmware transfer
    // If handleOTA returns without rebooting, something failed.
  }

  // ── 2. Periodic serial message ───────────────────────────
  unsigned long now = millis();
  if (now - lastPrintMillis >= PRINT_INTERVAL_MS) {
    lastPrintMillis = now;

    unsigned long uptime = (now - bootTime) / 1000;
    unsigned long mins   = uptime / 60;
    unsigned long secs   = uptime % 60;

    Serial.print("[MSG] ");
    Serial.print(OTA_MESSAGE);
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

// ══════════════════════════════════════════════════════════════
//  OTA HANDLER  (blocking once a client connects)
// ══════════════════════════════════════════════════════════════
void handleOTA(EthernetClient& client) {
  // ── Step 1: Read 4-byte firmware size (big-endian) ───────
  Serial.println("[OTA] Waiting for 4-byte size header...");

  unsigned long startWait = millis();
  while (client.available() < 4) {
    if (millis() - startWait > OTA_TIMEOUT_MS) {
      Serial.println("[OTA] ERROR: Timed out waiting for size header.");
      client.stop();
      return;
    }
    delay(1);
  }

  uint32_t firmwareSize = 0;
  firmwareSize |= ((uint32_t)client.read()) << 24;
  firmwareSize |= ((uint32_t)client.read()) << 16;
  firmwareSize |= ((uint32_t)client.read()) << 8;
  firmwareSize |= ((uint32_t)client.read());

  Serial.print("[OTA] Firmware size: ");
  Serial.print(firmwareSize);
  Serial.println(" bytes");

  if (firmwareSize == 0 || firmwareSize > 0x200000) {  // Sanity: 0 < size <= 2 MB
    Serial.println("[OTA] ERROR: Invalid firmware size. Aborting.");
    client.stop();
    return;
  }

  // ── Step 2: Begin Update ─────────────────────────────────
  if (!Update.begin(firmwareSize)) {
    Serial.print("[OTA] ERROR: Update.begin() failed: ");
    Update.printError(Serial);
    client.stop();
    return;
  }
  Serial.println("[OTA] Update.begin() OK. Receiving firmware...");

  // ── Step 3: Stream firmware data ─────────────────────────
  uint8_t buf[OTA_CHUNK_SIZE];
  uint32_t totalReceived = 0;
  int lastPercent = -1;
  unsigned long lastDataTime = millis();

  while (totalReceived < firmwareSize) {
    int bytesAvailable = client.available();
    if (bytesAvailable > 0) {
      int toRead = min((int)sizeof(buf), bytesAvailable);
      toRead = min(toRead, (int)(firmwareSize - totalReceived));
      int bytesRead = client.read(buf, toRead);

      if (bytesRead > 0) {
        size_t written = Update.write(buf, bytesRead);
        if (written != (size_t)bytesRead) {
          Serial.println("[OTA] ERROR: Update.write() size mismatch!");
          Update.printError(Serial);
          Update.abort();
          client.stop();
          return;
        }
        totalReceived += bytesRead;
        lastDataTime = millis();

        // Print progress every 5%
        int percent = (int)((totalReceived * 100UL) / firmwareSize);
        if (percent / 5 != lastPercent / 5) {
          lastPercent = percent;
          Serial.print("[OTA] Progress: ");
          Serial.print(percent);
          Serial.print("% (");
          Serial.print(totalReceived);
          Serial.print(" / ");
          Serial.print(firmwareSize);
          Serial.println(" bytes)");
        }
      }
    } else {
      // No data available — check timeout
      if (millis() - lastDataTime > OTA_TIMEOUT_MS) {
        Serial.println("[OTA] ERROR: Timed out waiting for firmware data.");
        Update.abort();
        client.stop();
        return;
      }
      delay(1);
    }
  }

  // ── Step 4: Finalize ─────────────────────────────────────
  Serial.println("[OTA] All bytes received. Finalizing update...");

  if (!Update.end(true)) {
    Serial.print("[OTA] ERROR: Update.end() failed: ");
    Update.printError(Serial);
    client.stop();
    return;
  }

  Serial.println("[OTA] ============================================");
  Serial.println("[OTA]   UPDATE SUCCESSFUL — Rebooting now...");
  Serial.println("[OTA] ============================================");
  Serial.flush();

  // Send confirmation back to uploader before closing and rebooting
  client.println("OK");
  client.flush();

  client.stop();
  delay(500);
  ESP.restart();
}
