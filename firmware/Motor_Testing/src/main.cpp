/**
 * Motor Testing — switches a 4-20 mA motor driver on and off over Ethernet/UDP.
 *
 * The driver is enabled by 5 V on its input, held there by a pull-up; an
 * N-channel MOSFET on PIN_MOTOR_ENABLE pulls it to 0 V, so the pin is
 * active-low (see motor_testing_pins.h).
 *
 * Two ways to switch it:
 *   - Ethernet: DAQv2 ACTUATOR_COMMAND packets on port 5005. This board owns
 *     actuator_id 1 (1-based, like the actuator board), state 1 = ON, 0 = OFF.
 *     Any packet sender works, e.g. test_guis/actuator_testing_gui.py with
 *     "send server heartbeat" ticked.
 *   - USB serial (115200): type "on", "off" or "status" and press Enter, for
 *     bench tests without a network.
 *
 * Failsafe: the output is OFF at boot. An Ethernet ON is ignored unless a
 * SERVER_HEARTBEAT is current, and drops to OFF if none arrives for
 * HEARTBEAT_TIMEOUT_MS, so a sender that stops talking cannot leave the motor
 * running. A serial ON is not tied to heartbeats -- the operator is at the
 * keyboard -- and holds until "off", an Ethernet OFF, or a reset. OFF from
 * either source is always obeyed.
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
// Who turned it on: a serial ON is exempt from the heartbeat failsafe.
static bool motor_on_from_serial = false;

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
            motor_on_from_serial = false;
            setMotor(true, "ethernet command");
        } else {
            Serial.println(
                "[MOTOR] ON ignored -- no current SERVER_HEARTBEAT (send "
                "heartbeats before commanding ON)");
            Serial.flush();
        }
    }
}

static void printStatus() {
    Serial.print("[MOTOR] ");
    Serial.print(motor_on ? "ON" : "OFF");
    if (motor_on)
        Serial.print(motor_on_from_serial ? " (serial)" : " (ethernet)");
    Serial.print(", server heartbeat ");
    Serial.print(serverHeartbeatCurrent() ? "current" : "none");
    Serial.print(", link ");
    Serial.print(Ethernet.linkStatus() == LinkON ? "up" : "down");
    Serial.print(", IP ");
    Serial.println(Ethernet.localIP());
    Serial.flush();
}

static void handleSerialLine(String line) {
    line.trim();
    line.toLowerCase();
    if (line.length() == 0)
        return;
    if (line == "on" || line == "1" || line == "off" || line == "0") {
        bool on = (line == "on" || line == "1");
        if (on == motor_on) {
            // setMotor() only logs a change; acknowledge the operator anyway.
            Serial.println(on ? "[MOTOR] already ON" : "[MOTOR] already OFF");
            Serial.flush();
        }
        if (on)
            motor_on_from_serial = true;
        setMotor(on, "serial command");
    } else if (line == "status") {
        printStatus();
    } else {
        Serial.print("[SERIAL] unknown command '");
        Serial.print(line);
        Serial.println("' -- use on, off or status");
    }
}

/** Non-blocking: collect characters until a newline, then act on the line. */
static void pollSerial() {
    static String line;
    while (Serial.available() > 0) {
        char c = static_cast<char>(Serial.read());
        if (c == '\n' || c == '\r') {
            handleSerialLine(line);
            line = "";
        } else if (line.length() < 32) {
            line += c;
        }
    }
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

    Serial.print("Hardware: ");
    Serial.println(Ethernet.hardwareStatus() == EthernetW5500
                       ? "W5500"
                       : "no W5500 detected -- check CS / SPI wiring");
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
    Serial.print("Motor: actuator_id ");
    Serial.print(MOTOR_ACTUATOR_ID);
    Serial.println(", OFF");
    Serial.println("Serial commands: on, off, status");
    Serial.flush();
}

void loop() {
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

    pollSerial();

    // Failsafe: an Ethernet ON with no current server heartbeat -> driver off.
    if (motor_on && !motor_on_from_serial && !serverHeartbeatCurrent())
        setMotor(false, "server heartbeat lost");

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

    delay(LOOP_DELAY_MS);
}
