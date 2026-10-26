/**
 * Motor Testing — switches a 4-20 mA motor driver on and off over Ethernet/UDP.
 *
 * The driver is enabled by 5 V on its input, held there by a pull-up; an
 * N-channel MOSFET on PIN_MOTOR_ENABLE pulls it to 0 V, so the pin is
 * active-low (see motor_testing_pins.h).
 *
 * Commands are DAQv2 ACTUATOR_COMMAND packets on UDP port 5005. This board
 * owns actuator_id 1 (1-based, like the actuator board), state 1 = ON, 0 = OFF.
 * test_guis/motor_gui.py sends them, with the heartbeats below.
 *
 * Failsafe: the output is OFF at boot. An ON is ignored unless a
 * SERVER_HEARTBEAT is current, and drops to OFF if none arrives for
 * HEARTBEAT_TIMEOUT_MS, so a sender that stops talking cannot leave the motor
 * running. OFF is always obeyed.
 *
 * Networking, heartbeats, firmware hash and Ethernet OTA match the hotfire
 * boards — see Hotfire_Code/common/board_net.h.
 */

#include <Arduino.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>
#include <STAR_EthernetOTA.h>
#include <daq-protocol.h>
#include <esp_mac.h>

#include <cstring>
#include <vector>

#include "actuator_config.h"
#include "board_net.h"
#include "firmware_hash.h"
#include "motor_testing_pins.h"

using namespace motor_testing_pins;

#ifndef MAX_PACKET_SIZE
#define MAX_PACKET_SIZE 512
#endif

#ifndef SENSOR_UDP_LISTEN_PORT
#define SENSOR_UDP_LISTEN_PORT 5005
#endif

// The single output this board drives, as addressed by ACTUATOR_COMMAND.
#define MOTOR_ACTUATOR_ID 1

static uint8_t board_id = BOARD_ID;
static byte mac[6];
static IPAddress staticIP(192, 168, 2, BOARD_ID);
static IPAddress gateway(0, 0, 0, 0);
static IPAddress subnet(255, 255, 255, 0);
static IPAddress dns(192, 168, 2, 1);
static IPAddress serverIP(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
static EthernetUDP udp;
static StarOTA::Server otaServer(HOTFIRE_OTA_PORT);
static BoardNet::State net;
static unsigned long lastHeartbeatMillis = 0;
static unsigned long last_server_heartbeat_ms = 0;
static bool server_heartbeat_seen = false;
static daq::EngineState last_engine_state = daq::EngineState::SAFE;
static bool motor_on = false;
// False when no W5500 answered at boot. The Ethernet library then reads
// garbage socket state and the loop's network calls can stall, so every
// network call is skipped and the output stays OFF.
static bool eth_present = false;

/** Freeze our DHCP address for the duration of an OTA flash. */
static void otaFreezeAddress(void*, uint32_t) {
    BoardNet::beginOtaHold(net);
}

static bool serverHeartbeatCurrent() {
    return server_heartbeat_seen &&
           (millis() - last_server_heartbeat_ms) <= HEARTBEAT_TIMEOUT_MS;
}

static void setMotor(bool on, const char* reason) {
    digitalWrite(PIN_MOTOR_ENABLE, on ? LOW : HIGH);
    if (on != motor_on) {
        motor_on = on;
        Serial.print("[MOTOR] ");
        Serial.print(on ? "ON" : "OFF");
        Serial.print(" (");
        Serial.print(reason);
        Serial.println(")");
        Serial.flush();
    }
}

static void processActuatorCommands(
    const std::vector<daq::ActuatorCommand>& commands) {
    for (const auto& cmd : commands) {
        if (cmd.actuator_id != MOTOR_ACTUATOR_ID)
            continue;
        if (cmd.actuator_state == 0) {
            setMotor(false, "ethernet command");
        } else if (serverHeartbeatCurrent()) {
            setMotor(true, "ethernet command");
        } else {
            Serial.println(
                "[MOTOR] ON ignored -- no current SERVER_HEARTBEAT (send "
                "heartbeats before commanding ON)");
            Serial.flush();
        }
    }
}

/**
 * Read the W5500's VERSIONR (common register 0x0039, always 0x04) straight
 * over SPI and say what the answer implies, so a dead link can be traced to
 * a wire without a logic analyser.
 */
static void probeW5500Version() {
    SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
    digitalWrite(ETH_CS, LOW);
    SPI.transfer(0x00);  // address high
    SPI.transfer(0x39);  // address low: VERSIONR
    SPI.transfer(0x00);  // control: common block, read, variable length
    uint8_t version = SPI.transfer(0x00);
    digitalWrite(ETH_CS, HIGH);
    SPI.endTransaction();

    Serial.print("[ETH] W5500 VERSIONR read: 0x");
    if (version < 0x10)
        Serial.print("0");
    Serial.print(version, HEX);
    if (version == 0x04)
        Serial.println(" -- chip answers; init failed, try a reset");
    else if (version == 0x00)
        Serial.println(" -- MISO stuck low: check MISO (19), SCK (18), CS (5)"
                       " and the module's GND");
    else if (version == 0xFF)
        Serial.println(" -- MISO floating/high: check MISO (19), CS (5) and"
                       " the module's 3.3 V");
    else
        Serial.println(" -- garbled: check MOSI (23), SCK (18), loose jumpers");
    Serial.flush();
}

static void sendBoardHeartbeatTo(IPAddress ip, uint16_t port) {
    daq::BoardHeartbeatPacket hb;
    memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
    hb.board_id = board_id;
    hb.engine_state = last_engine_state;
    hb.board_state = serverHeartbeatCurrent() ? daq::BoardState::ACTIVE
                                              : daq::BoardState::SETUP;

    uint8_t packetBuffer[MAX_PACKET_SIZE];
    size_t len = daq::create_board_heartbeat_packet(hb, millis(), packetBuffer,
                                                    sizeof(packetBuffer));
    if (len == 0)
        return;

    udp.beginPacket(ip, port);
    udp.write(packetBuffer, len);
    udp.endPacket();
}

static void handlePacket(const uint8_t* buffer, size_t len,
                         IPAddress remoteIP) {
    if (len < sizeof(daq::PacketHeader))
        return;
    daq::PacketHeader hdr;
    memcpy(&hdr, buffer, sizeof(hdr));
    switch (hdr.packet_type) {
        case daq::PacketType::SERVER_HEARTBEAT: {
            daq::PacketHeader dummy;
            daq::ServerHeartbeatPacket sh;
            if (daq::parse_server_heartbeat_packet(buffer, len, dummy, sh)) {
                last_server_heartbeat_ms = millis();
                server_heartbeat_seen = true;
                last_engine_state = sh.engine_state;
#ifdef SENSOR_ETH_USE_DHCP
                BoardNet::onServerPacket(net, remoteIP, serverIP);
#endif
            }
            break;
        }
        case daq::PacketType::ACTUATOR_COMMAND: {
            daq::PacketHeader dummy;
            std::vector<daq::ActuatorCommand> commands;
            if (daq::parse_actuator_command_packet(buffer, len, dummy,
                                                   commands))
                processActuatorCommands(commands);
            break;
        }
        default:
            break;
    }
}

void setup() {
    // First thing: drive the enable OFF (HIGH, active-low) before anything
    // that waits. Write the level before switching to OUTPUT so the pin never
    // glitches LOW (= ON) on the way.
    digitalWrite(PIN_MOTOR_ENABLE, HIGH);
    pinMode(PIN_MOTOR_ENABLE, OUTPUT);

    Serial.begin(115200);
    delay(SERIAL_MONITOR_READY_DELAY_MS);
    FirmwareHash::print();
    Serial.println("Motor Testing starting...");

    board_id = static_cast<uint8_t>(BOARD_ID);
    staticIP = IPAddress(192, 168, 2, board_id);
    Serial.print("Board ID / fallback IP: ");
    Serial.print(static_cast<unsigned>(board_id));
    Serial.print(" / 192.168.2.");
    Serial.println(static_cast<unsigned>(board_id));

    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
    BoardNet::configure(net, mac, staticIP, subnet);
    BoardNet::printMac(net);
    SPI.begin(ETH_SCLK, ETH_MISO, ETH_MOSI, ETH_CS);
    delay(ETHERNET_SPI_DELAY_MS);
    Ethernet.init(ETH_CS);
    delay(ETHERNET_INIT_DELAY_MS);
#ifdef SENSOR_ETH_USE_DHCP
    BoardNet::begin(net, dns, gateway);
#else
    Ethernet.begin(mac, staticIP, dns, gateway, subnet);
#endif
    delay(ETHERNET_BEGIN_DELAY_MS);

    eth_present = Ethernet.hardwareStatus() == EthernetW5500;
    Serial.print("Hardware: ");
    Serial.println(eth_present ? "W5500"
                               : "no W5500 detected -- check CS / SPI wiring "
                                 "and power. Ethernet disabled; motor stays "
                                 "OFF.");
    if (!eth_present)
        probeW5500Version();
    if (eth_present) {
        Serial.print("Link status: ");
        Serial.println(Ethernet.linkStatus() == LinkON ? "Connected"
                                                       : "Disconnected");
        Serial.print("Ethernet IP: ");
        Serial.println(Ethernet.localIP());

        udp.begin(SENSOR_UDP_LISTEN_PORT);
        otaServer.onStart(otaFreezeAddress);
        otaServer.begin();
        Serial.print("UDP listen port ");
        Serial.println(SENSOR_UDP_LISTEN_PORT);
        Serial.print("OTA TCP port ");
        Serial.println(HOTFIRE_OTA_PORT);
    }
    Serial.print("Motor: actuator_id ");
    Serial.print(MOTOR_ACTUATOR_ID);
    Serial.println(", OFF");
    Serial.flush();
}

static void pollNetwork() {
#ifdef SENSOR_ETH_USE_DHCP
    BoardNet::maintainLease(net);
#endif
    // Blocks only if a client connects; never returns on success.
    otaServer.poll();
    StarOTA::printTestMessage();

    int packetSize = udp.parsePacket();
    if (packetSize > 0) {
        IPAddress remoteIP = udp.remoteIP();
        uint8_t packetBuffer[MAX_PACKET_SIZE];
        int bytesRead = udp.read(packetBuffer, sizeof(packetBuffer));
        if (bytesRead > 0)
            handlePacket(packetBuffer, static_cast<size_t>(bytesRead),
                         remoteIP);
    }

#ifdef SENSOR_ETH_USE_DHCP
    if (BoardNet::serverWentSilent(net)) {
        net.serverLearned = false;
        serverIP = IPAddress(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
        Serial.println("[NET] server silent -- resuming discovery");
        Serial.flush();
    }
#endif

    unsigned long now = millis();
    if (now - lastHeartbeatMillis >= BOARD_HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatMillis = now;
        sendBoardHeartbeatTo(serverIP, HOTFIRE_SERVER_PORT);
#ifdef SENSOR_ETH_USE_DHCP
        // Discovery: announce to everyone until a server is learned.
        if (!net.serverLearned)
            sendBoardHeartbeatTo(IPAddress(255, 255, 255, 255),
                                 HOTFIRE_SERVER_PORT);
#endif
    }
}

void loop() {
    // Failsafe: no current server heartbeat -> driver off.
    if (motor_on && !serverHeartbeatCurrent())
        setMotor(false, "server heartbeat lost");

    if (eth_present)
        pollNetwork();

    delay(LOOP_DELAY_MS);
}
