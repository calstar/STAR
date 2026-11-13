#include "main.h"

#include <Adafruit_BME280.h>
#include <Arduino.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>
#include <STAR_EthernetOTA.h>
#include <Wire.h>
#include <daq-protocol.h>
#include <esp_mac.h>

#include "firmware_hash.h"
#include "pins.h"

static Adafruit_BME280 bme;
static EthernetUDP udp;
static StarOTA::Server ota_server(ENV_OTA_PORT);

static byte mac[6];
static IPAddress server_ip(192, 168, 2, ENV_SERVER_IP_OCTET_4);
static IPAddress static_ip(192, 168, 2, ENV_BOARD_ID);
static IPAddress gateway(192, 168, 2, 1);
static IPAddress subnet(255, 255, 255, 0);
static IPAddress dns_ip(192, 168, 2, 1);

// Each function stands alone: a missing BME280 must not take down the board
// (it will relay the Bluetooth switches too). Only Ethernet is fatal, since
// without it the board can do nothing useful.
static bool bme_ok = false;

// Sized for the largest packet sent: a LOGS line (~50 bytes)
static uint8_t pkt_buf[96];

void setup() {
    // No waiting for a USB host: on the pad nothing is plugged in, and the
    // C3's USB console would block here forever.
    Serial.begin(115200);

    FirmwareHash::print();
    Serial.println("Environmental Tracker starting...");

    // BME280: optional. Missing is reported to the server and retried.
    Wire.begin(PIN_SDA, PIN_SCL);
    bme_ok = bme.begin(BME280_I2C_ADDR, &Wire);
    Serial.println(bme_ok ? "BME280 OK"
                          : "ERROR: BME280 not found. Check wiring and I2C "
                            "address! Continuing without it.");

    // Ethernet — mirrors hotfire sensor board init (no ETH_RST)
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
    SPI.begin(PIN_ETH_SCLK, PIN_ETH_MISO, PIN_ETH_MOSI, PIN_ETH_CS);
    delay(ENV_ETH_SPI_DELAY_MS);
    Ethernet.init(PIN_ETH_CS);
    delay(ENV_ETH_INIT_DELAY_MS);
    Ethernet.begin(mac, static_ip, dns_ip, gateway, subnet);
    delay(ENV_ETH_BEGIN_DELAY_MS);

    // The one fatal failure: no W5500 answering. Reboot and try again.
    if (Ethernet.hardwareStatus() == EthernetNoHardware) {
        Serial.printf("ERROR: W5500 not found. Rebooting in %d ms.\n",
                      ENV_ETH_RETRY_REBOOT_MS);
        Serial.flush();
        delay(ENV_ETH_RETRY_REBOOT_MS);
        ESP.restart();
    }

    udp.begin(ENV_LOCAL_PORT);
    ota_server.begin();

    Serial.print("IP: ");
    Serial.println(Ethernet.localIP());
    Serial.print("Server: 192.168.2.");
    Serial.print(ENV_SERVER_IP_OCTET_4);
    Serial.print(":");
    Serial.println(ENV_SERVER_PORT);
    Serial.print("Send rate: ");
    Serial.print(ENV_SEND_RATE_HZ);
    Serial.println(" Hz");
    Serial.print("OTA port: ");
    Serial.println(ENV_OTA_PORT);
    Serial.println("Setup complete.");
    Serial.flush();
}

void loop() {
    static unsigned long last_env_send = 0;
    static unsigned long last_heartbeat = 0;

    // OTA — non-blocking poll; blocks only if a client actually connects
    // Blocks only if a client connects; never returns on success.
    ota_server.poll();
    StarOTA::printTestMessage();

    // Receive UDP — log SERVER_HEARTBEAT, discard everything else
    int pkt_size = udp.parsePacket();
    if (pkt_size > 0) {
        int bytes_read = udp.read(pkt_buf, sizeof(pkt_buf));
        if (bytes_read > 0 && static_cast<daq::PacketType>(pkt_buf[0]) ==
                                  daq::PacketType::SERVER_HEARTBEAT) {
            daq::PacketHeader hdr;
            daq::ServerHeartbeatPacket data;
            if (daq::parse_server_heartbeat_packet(pkt_buf, bytes_read, hdr,
                                                   data)) {
                Serial.print("Server heartbeat received (t=");
                Serial.print(hdr.timestamp);
                Serial.println("ms)");
            }
        }
    }

    unsigned long now = millis();

    // BME280 missing: retry it, and tell the server (board logs) why there
    // is no environmental data.
    static unsigned long last_bme_retry = 0;
    if (!bme_ok && now - last_bme_retry >= ENV_BME_RETRY_INTERVAL_MS) {
        last_bme_retry = now;
        bme_ok = bme.begin(BME280_I2C_ADDR, &Wire);
        const char *msg = bme_ok ? "BME280 found; environmental data resumes\n"
                                 : "BME280 not found; no environmental data\n";
        Serial.print(msg);
        size_t n = daq::create_log_packet(
            0, reinterpret_cast<const uint8_t *>(msg), strlen(msg), now,
            pkt_buf, sizeof(pkt_buf));
        if (n > 0) {
            udp.beginPacket(server_ip, ENV_SERVER_PORT);
            udp.write(pkt_buf, n);
            udp.endPacket();
        }
    }

    // Send ENVIRONMENTAL_DATA at ENV_SEND_RATE_HZ
    if (bme_ok && now - last_env_send >= ENV_SEND_INTERVAL_MS) {
        last_env_send = now;

        float temp = bme.readTemperature();
        uint32_t press = (uint32_t)bme.readPressure();
        float hum = bme.readHumidity();

        size_t n = daq::create_environmental_data_packet(
            temp, press, hum, millis(), pkt_buf, sizeof(pkt_buf));
        if (n > 0) {
            udp.beginPacket(server_ip, ENV_SERVER_PORT);
            udp.write(pkt_buf, n);
            udp.endPacket();
        }

        Serial.printf("ENV: %.2f C  %lu Pa  %.2f %%RH\n", temp, press, hum);
    }

    // Send BOARD_HEARTBEAT at ENV_HEARTBEAT_INTERVAL_MS — always
    // BoardState::ACTIVE
    if (now - last_heartbeat >= ENV_HEARTBEAT_INTERVAL_MS) {
        last_heartbeat = now;

        daq::BoardHeartbeatPacket hb;
        memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
        hb.board_id = ENV_BOARD_ID;
        hb.engine_state = daq::EngineState::SAFE;
        hb.board_state = daq::BoardState::ACTIVE;

        size_t n = daq::create_board_heartbeat_packet(hb, millis(), pkt_buf,
                                                      sizeof(pkt_buf));
        if (n > 0) {
            udp.beginPacket(server_ip, ENV_SERVER_PORT);
            udp.write(pkt_buf, n);
            udp.endPacket();
        }
    }

    delay(10);
}
