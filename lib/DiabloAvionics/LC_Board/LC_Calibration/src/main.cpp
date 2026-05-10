#include <Arduino.h>
#include <SPI.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <DAQv2-Comms.h>
#include <cstring>
#include <vector>
#include <esp_mac.h>

#include "STAR_ADS126X.h"

// Change the following line to automatically use the correct pins for the board being tested (PT_Board, LC_Board, RTD_Board, or TC_Board)
#define PINS_ACTIVE_LAYOUT sense_board_pins::LC_Board

// These lines MUST be after the #define PINS_ACTIVE_LAYOUT or they will overwrite it with the default value!
#include "sense_board_pins.h"
#include "connector_adc_map.h"
#include "adc_mappings.h"

using namespace sense_board_pins;

static ADS126X ads126x;
SPIClass ADC_SPI(HSPI);   // ADC on HSPI, Ethernet on default SPI (VSPI)

// LC Board ADC1 connectors: 1, 2, 3, 6, 7
const uint8_t ADC1_CONNECTORS[] = {1, 2, 3, 6, 7};
const uint8_t NUM_LC_SENSORS = sizeof(ADC1_CONNECTORS) / sizeof(ADC1_CONNECTORS[0]);
#define FILTER    ADS126X_SINC4
#define DATA_RATE ADS126X_RATE_1200

// ---------------------------------------------------------------------------
// Ethernet
// ---------------------------------------------------------------------------
byte mac[6];
IPAddress staticIP(192, 168, 2, 100);
IPAddress gateway(192, 168, 2, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);
IPAddress receiverIP(192, 168, 2, 20);
const int receiverPort = 5006;
EthernetUDP udp;
uint8_t packetBuffer[MAX_PACKET_SIZE];

float convert_code_to_voltage(int32_t code)
{
  // Assumes the 2.5V internal reference is being used!
  return ((float)code * 2.5f) / 2147483648.0f;
}

void flush_cycles(int n) {
  for (int i = 0; i < n; i++) {
    while (digitalRead(Pins.ADC_DRDY_1) != LOW)
      delayMicroseconds(1);
    ads126x.readADC1();
  }
}

void setup()
{
  Serial.begin(115200);
  while (!Serial)
    delay(10);
  delay(500);

  Serial.println("LC Calibration - Based on LC_Simple_Test with Ethernet");

  // Setup SPI for ADC (HSPI) - exactly like LC_Simple_Test
  ADC_SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI);

  // Due to the ADC output having valid data on FALLING CLK edges
  ADC_SPI.setDataMode(SPI_MODE1);
  pinMode(Pins.ADC_DRDY_1, INPUT);

  // Setup ADC - exactly like LC_Simple_Test
  ads126x.begin(Pins.ADC_CS_1, &ADC_SPI);

  ads126x.enablePGA();
  ads126x.setGain(ADS126X_GAIN_8);

  // Stop it while we config it, as suggested by datasheet
  ads126x.stopADC1();

  // Set the filter. You can change this to try different filters
  ads126x.setFilter(FILTER);

  // Set the datarate. You can change this, but the options depends on the filter
  ads126x.setRate(DATA_RATE);

  // Start ADC now that configuration is done
  ads126x.startADC1();

  // Ethernet (default SPI / VSPI)
  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
  SPI.begin(Pins.ETH_SCLK, Pins.ETH_MISO, Pins.ETH_MOSI);
  delay(300);
  Ethernet.init(Pins.ETH_CS);
  delay(300);
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(300);
  udp.begin(5005);

  Serial.print("IP: ");
  Serial.println(Ethernet.localIP());
  Serial.print("Link: ");
  Serial.println(Ethernet.linkStatus() == LinkON ? "ON" : "OFF");
  Serial.print("Send to: ");
  Serial.print(receiverIP);
  Serial.print(":");
  Serial.println(receiverPort);
  Serial.print("Reading LC connectors: ");
  for (uint8_t i = 0; i < NUM_LC_SENSORS; i++) {
    Serial.print(ADC1_CONNECTORS[i]);
    if (i < NUM_LC_SENSORS - 1) Serial.print(", ");
  }
  Serial.println();
  Serial.println();
}

void loop()
{
  // Create sensor data chunk with timestamp
  Diablo::SensorDataChunkCollection chunk(millis(), NUM_LC_SENSORS);

  // Read all ADC1 LC connectors (connectors 1, 2, 3, 6, 7)
  for (uint8_t i = 0; i < NUM_LC_SENSORS; i++) {
    uint8_t conn = ADC1_CONNECTORS[i];
    
    // Get ADC channels for pin 1 (positive) and pin 2 (negative)
    int pos_channel = getAdcChannel(conn, 1);
    int neg_channel = getAdcChannel(conn, 2);
    
    float voltage = 0.0f;
    
    if (pos_channel >= 0 && neg_channel >= 0) {
      // Set input mux for differential reading (pin 1 vs pin 2)
      ads126x.setInputMux(pos_channel, neg_channel);
      
      // Flush cycles to let mux settle after change
      flush_cycles(settlePulses(FILTER, DATA_RATE));
      
      // Wait for DRDY pin - exactly like LC_Simple_Test
      while (digitalRead(Pins.ADC_DRDY_1) != LOW)
      {
        delayMicroseconds(10);
      }

      delayMicroseconds(25);

      // Get the most recent value - exactly like LC_Simple_Test
      const auto reading = ads126x.readADC1();
      
      if (reading.checksumValid) {
        voltage = convert_code_to_voltage(reading.value);
        
        // Print to serial
        Serial.print("LC ");
        Serial.print(conn);
        Serial.print(": ");
        Serial.print(voltage, 6);
        Serial.println(" V");
      } else {
        Serial.print("LC ");
        Serial.print(conn);
        Serial.println(": Bad checksum!");
      }
    }
    
    // Convert float to uint32_t bits for packet
    uint32_t vbits;
    memcpy(&vbits, &voltage, sizeof(float));
    // Sensor ID is 0-based index (0-4 for connectors 1,2,3,6,7)
    chunk.add_datapoint(i, vbits);
  }

  Serial.println(); // Blank line between readings

  // Send packet via Ethernet UDP
  std::vector<Diablo::SensorDataChunkCollection> chunks;
  chunks.push_back(chunk);

  size_t packetSize = Diablo::create_sensor_data_packet(chunks, NUM_LC_SENSORS, millis(), packetBuffer, sizeof(packetBuffer));
  if (packetSize > 0) {
    udp.beginPacket(receiverIP, receiverPort);
    udp.write(packetBuffer, packetSize);
    udp.endPacket();
    
    Serial.print("Sent ");
    Serial.print(packetSize);
    Serial.print(" B, ");
    Serial.print(NUM_LC_SENSORS);
    Serial.println(" LCs");
  }

  delay(100);
}
