// #include <WiFi.h>
// #include <ETH.h>
// #include <SPI.h>
// #include <EthernetUdp.h>
// #include <Ethernet.h>
// #include <ADS126X.h>
// #include <esp_system.h>


// #define ETH_CLK_PIN   7
// #define ETH_MISO_PIN  41
// #define ETH_MOSI_PIN  13
// #define ETH_CS_PIN    6
// #define ETH_PHY_ADDR  0

// IPAddress staticIP(192, 168, 2, 100);
// IPAddress gateway(192, 168, 2, 1);
// IPAddress subnet(255, 255, 255, 0);
// IPAddress dns(192, 168, 2, 1);
// IPAddress receiverIP(192, 168, 2, 1);
// const int receiverPort = 5006;
// EthernetUDP udp;
// void EthernetInit() {
//     // Generate MAC
//     uint64_t chipid = ESP.getEfuseMac();
//     byte mac[6];
//     mac[0] = 0x02;
//     mac[1] = 0x00;
//     mac[2] = (chipid >> 32) & 0xFF;
//     mac[3] = (chipid >> 24) & 0xFF;
//     mac[4] = (chipid >> 16) & 0xFF;
//     mac[5] = (chipid >> 8) & 0xFF;

//     // SPI + Ethernet
//     SPI.begin(ETH_CLK_PIN, ETH_MISO_PIN, ETH_MOSI_PIN, ETH_CS_PIN);
//     Ethernet.init(ETH_CS_PIN);
//     Ethernet.begin(mac, staticIP, dns, gateway, subnet);

//     udp.begin(5005);
// }

// ADS126X adc;
// #define DRDY_PIN 7
// #define DOUT 41
// #define DIN 5
// #define SCLK 13
// #define CS 40
// int pos_pin = 0;      // Positive input (AIN0)
// int neg_pin = 0xA;    // Negative input (AINCOM)

// #define BUFFER_SIZE 1000
// String buffer[BUFFER_SIZE];
// int bufferIndex = 0;

// adc.setReference(ADS126X_REF_NEG_VSS, ADS126X_REF_POS_VDD);
// uint8_t power = adc.readRegister(ADS126X_POWER);
// power &= ~(1 << 2);
// adc.writeRegister(ADS126X_POWER);

// unsigned long start_time = 0;
// unsigned long readTime = 0;
// int readCount = 0;

// void setup() {
//   Serial.begin(115200);
//   Serial.println("Ethernet + ADC UDP Sender");

//   // --- SPI + ADC Setup ---
//   adc.begin(CS);
//   adc.startADC1();
//   adc.setRate(ADS126X_RATE_38400);
//   pinMode(DRDY_PIN, INPUT);

//   // --- Ethernet Setup ---
//   SPI.begin(ETH_CLK_PIN, ETH_MISO_PIN, ETH_MOSI_PIN, ETH_CS_PIN);
//   delay(1000);
//   EthernetInit();
//   delay(1000);

//   Serial.print("ESP32 IP: ");
//   Serial.println(Ethernet.localIP());

//   udp.begin(5005); // local UDP port
// }

// void loop() {
//   // Wait for ADC ready

//   while (digitalRead(DRDY_PIN) == HIGH) {
//     // wait
//   }
//   start_time = micros();
//   long rawValue = adc.readADC1(pos_pin, neg_pin); // raw ADC
//   while (digitalRead(DRDY_PIN) == HIGH) {
//     // wait
//   }
//   rawValue = adc.readADC1(pos_pin, neg_pin); // raw ADC
//   float voltage = (float)(rawValue) * 5.0 / 8388608.0; // Convert to voltage
//   readTime = micros() - start_time;

//   readCount++;

//   String sample = String(rawValue) + "," + String(voltage, 6) + "," +
//                     String(millis()) + "," + String(readTime);

//   buffer[bufferIndex++] = sample;

//   //UPDATES BUFFER

//   if (bufferIndex >= BUFFER_SIZE) {

//     Serial.println("Buffer full, sending UDP packet...");

//     // Concatenate buffer into one big string
//     String packetData;
//     for (int i = 0; i < BUFFER_SIZE; i++) {
//         packetData += buffer[i] + "\n";
//     }

//     // Send over UDP
//     udp.beginPacket(receiverIP, receiverPort);
//     udp.write(packetData.c_str());
//     udp.endPacket();

//     Serial.println("UDP packet sent!");

//     // Clear buffer
//     bufferIndex = 0;
// }


//   delay(5); // adjust data rate
// }