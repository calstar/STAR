#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <esp_mac.h>
#include <Adafruit_BME280.h>
#include <DAQv2-Comms.h>
#include "firmware_hash.h"
#include "hotfire_ota.h"
#include "pins.h"
#include "main.h"

static Adafruit_BME280 bme;
static EthernetUDP udp;
static OTAEthernetServer ota_server(ENV_OTA_PORT);

static byte mac[6];
static IPAddress server_ip(192, 168, 2, ENV_SERVER_IP_OCTET_4);
static IPAddress static_ip(192, 168, 2, ENV_BOARD_ID);
static IPAddress gateway(192, 168, 2, 1);
static IPAddress subnet(255, 255, 255, 0);
static IPAddress dns_ip(192, 168, 2, 1);

// Sized for the largest packet sent: BOARD_HEARTBEAT (~41 bytes)
static uint8_t pkt_buf[64];

void setup() {
    Serial.begin(115200);
    while (!Serial) delay(10);

    FirmwareHash::print();
    Serial.println("Environmental Tracker starting...");

    // BME280
    Wire.begin(PIN_SDA, PIN_SCL);
    if (!bme.begin(BME280_I2C_ADDR, &Wire)) {
        Serial.println("ERROR: BME280 not found. Check wiring and I2C address!");
        while (1) delay(100);
    }
    Serial.println("BME280 OK");

    // Ethernet — mirrors hotfire sensor board init (no ETH_RST)
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
    SPI.begin(PIN_ETH_SCLK, PIN_ETH_MISO, PIN_ETH_MOSI, PIN_ETH_CS);
    delay(ENV_ETH_SPI_DELAY_MS);
    Ethernet.init(PIN_ETH_CS);
    delay(ENV_ETH_INIT_DELAY_MS);
    Ethernet.begin(mac, static_ip, dns_ip, gateway, subnet);
    delay(ENV_ETH_BEGIN_DELAY_MS);

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
    EthernetClient ota_client = ota_server.available();
    if (ota_client) hotfire_handleOTA(ota_client);

    // Receive UDP — log SERVER_HEARTBEAT, discard everything else
    int pkt_size = udp.parsePacket();
    if (pkt_size > 0) {
        int bytes_read = udp.read(pkt_buf, sizeof(pkt_buf));
        if (bytes_read > 0 &&
            static_cast<Diablo::PacketType>(pkt_buf[0]) == Diablo::PacketType::SERVER_HEARTBEAT) {
            Diablo::PacketHeader hdr;
            Diablo::ServerHeartbeatPacket data;
            if (Diablo::parse_server_heartbeat_packet(pkt_buf, bytes_read, hdr, data)) {
                Serial.print("Server heartbeat received (t=");
                Serial.print(hdr.timestamp);
                Serial.println("ms)");
            }
        }
    }

    unsigned long now = millis();

    // Send ENVIRONMENTAL_DATA at ENV_SEND_RATE_HZ
    if (now - last_env_send >= ENV_SEND_INTERVAL_MS) {
        last_env_send = now;

        float temp       = bme.readTemperature();
        uint32_t press   = (uint32_t)bme.readPressure();
        float hum        = bme.readHumidity();

        size_t n = Diablo::create_environmental_data_packet(
            temp, press, hum, millis(), pkt_buf, sizeof(pkt_buf));
        if (n > 0) {
            udp.beginPacket(server_ip, ENV_SERVER_PORT);
            udp.write(pkt_buf, n);
            udp.endPacket();
        }

        Serial.printf("ENV: %.2f C  %lu Pa  %.2f %%RH\n", temp, press, hum);
    }

    // Send BOARD_HEARTBEAT at ENV_HEARTBEAT_INTERVAL_MS — always BoardState::ACTIVE
    if (now - last_heartbeat >= ENV_HEARTBEAT_INTERVAL_MS) {
        last_heartbeat = now;

        Diablo::BoardHeartbeatPacket hb;
        memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
        hb.board_id     = ENV_BOARD_ID;
        hb.engine_state = Diablo::EngineState::SAFE;
        hb.board_state  = Diablo::BoardState::ACTIVE;

        size_t n = Diablo::create_board_heartbeat_packet(
            hb, millis(), pkt_buf, sizeof(pkt_buf));
        if (n > 0) {
            udp.beginPacket(server_ip, ENV_SERVER_PORT);
            udp.write(pkt_buf, n);
            udp.endPacket();
        }
    }

    delay(10);
}
