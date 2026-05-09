// ESP32 Real-Time Current Monitoring and Actuator Control System
// This code uses the robust Ethernet library for industrial control.

// --- Library Includes ---
#include <Arduino.h>
#include <SPI.h>     // Required for Ethernet module
#include <Ethernet.h>  // Standard Ethernet library

// --- Configuration ---
// Replace with your actual sensor and actuator pin definitions
const int CURRENT_SENSOR_PIN = 34; // Example ADC pin on ESP32
const int ACTUATOR_DRIVER_PIN = 25; // Example GPIO pin for the driver chip
const int ACTUATOR_PWM_CHANNEL = 0; 
const int PWM_FREQUENCY = 5000;
const int PWM_RESOLUTION = 10; // 0-1023 resolution

// Ethernet/Network Configuration
byte mac[] = { 0xDE, 0xD, 0xBE, 0xEF, 0xFE, 0xED };
const int CS_PIN = 5; // Chip Select pin for your Ethernet module

// Server configuration
const char* SERVER_IP = "192.168.1.10"; // Server IP address (Placeholder)
const int SERVER_PORT = 8000;         // Server port (Placeholder)

// Network client object
EthernetClient serverClient; 

// Timing configuration for the main loop current reading/sending
const long CURRENT_READ_INTERVAL_MS = 500; // Read/send current every 500ms
unsigned long lastCurrentReadTime = 0;

// --- Actuator/Command State ---
enum ActuatorState {
    OFF,
    LOW,
    HIGH
};
ActuatorState currentActuatorState = OFF;

// --- Function Declarations ---
void connectToServer();
float readCurrentSensor();
void sendCurrent(float current);
void handleIncomingCommands(); 
void decodeAndActuate(String command);

// --------------------------------------------------------------------------------
// SETUP
// --------------------------------------------------------------------------------
void setup() {
    Serial.begin(115200);
    delay(100);
    Serial.println("\n--- ESP32 Control System Booting (Ethernet Mode) ---");

    // 1. Initialize Actuator Pin (using PWM)
    ledcSetup(ACTUATOR_PWM_CHANNEL, PWM_FREQUENCY, PWM_RESOLUTION);
    ledcAttachPin(ACTUATOR_DRIVER_PIN, ACTUATOR_PWM_CHANNEL);
    ledcWrite(ACTUATOR_PWM_CHANNEL, 0); // Start OFF

    // 2. Initialize Ethernet Network
    Serial.print("Initializing Ethernet...");
    pinMode(CS_PIN, OUTPUT);
    Ethernet.init(CS_PIN); 

    if (Ethernet.begin(mac) == 0) {
        Serial.println("Failed to configure Ethernet using DHCP");
        if (Ethernet.hardwareStatus() == EthernetNoHardware) {
            Serial.println("Ethernet shield not found. Check wiring.");
            while (true) { delay(1); } // Halt the program
        }
    }
    
    Serial.println("Done.");
    Serial.print("Assigned IP Address: ");
    Serial.println(Ethernet.localIP());

    // 3. Connect to the Server
    connectToServer();
}

// --------------------------------------------------------------------------------
// LOOP
// --------------------------------------------------------------------------------
void loop() {
    Ethernet.maintain(); 
    
    // 1. NON-BLOCKING COMMAND CHECK (High-priority network handler)
    handleIncomingCommands();

    // 2. PERIODIC CURRENT READING AND SENDING
    unsigned long currentTime = millis();
    if (currentTime - lastCurrentReadTime >= CURRENT_READ_INTERVAL_MS) {
        lastCurrentReadTime = currentTime;

        float currentReading = readCurrentSensor();
        sendCurrent(currentReading);
    }
}

// --------------------------------------------------------------------------------
// UTILITY FUNCTIONS
// --------------------------------------------------------------------------------

void connectToServer() {
    Serial.print("Connecting to server...");
    if (serverClient.connect(SERVER_IP, SERVER_PORT)) {
        Serial.println("Connection successful.");
        serverClient.println("ESP32_ID: SENSOR_001_READY");
    } else {
        Serial.println("Connection failed.");
    }
}

float readCurrentSensor() {
    int rawValue = analogRead(CURRENT_SENSOR_PIN);
    // Placeholder conversion:
    float voltage = (float)rawValue * (3.3 / 4095.0); 
    float current = voltage * 5.0; 

    Serial.printf("[LOOP] Reading: Current=%.2f A\n", current);
    return current;
}

void sendCurrent(float current) {
    if (serverClient.connected()) {
        String message = "CURRENT:";
        message += String(current, 2); 
        serverClient.println(message);
        Serial.printf("[LOOP] Sent: %s\n", message.c_str());
    } else {
        Serial.println("[LOOP] Server connection lost. Reconnecting...");
        connectToServer();
    }
}

// --------------------------------------------------------------------------------
// INTERRUPT LOGIC 
// --------------------------------------------------------------------------------

void handleIncomingCommands() {
    if (serverClient.connected()) {
        if (serverClient.available()) {
            Serial.println("\n[INTERRUPT] Signal received!");
            String command = serverClient.readStringUntil('\n');
            command.trim(); 
            decodeAndActuate(command);
        }
    } else {
        if (millis() - lastCurrentReadTime > CURRENT_READ_INTERVAL_MS * 2) {
             connectToServer();
        }
    }
}

void decodeAndActuate(String command) {
    Serial.printf("[INTERRUPT] Decoding command: '%s'\n", command.c_str());

    // --- DECODE LOGIC ---
    if (command.startsWith("ACTUATE:HIGH")) {
        currentActuatorState = HIGH;
    } else if (command.startsWith("ACTUATE:LOW")) {
        currentActuatorState = LOW;
    } else if (command.startsWith("ACTUATE:OFF")) {
        currentActuatorState = OFF;
    } else {
        Serial.println("[INTERRUPT] WARNING: Unknown command received.");
        return;
    }

    // --- ACTUATE LOGIC ---
    int pwmDutyCycle = 0;
    if (currentActuatorState == OFF) {
        pwmDutyCycle = 0; 
    } else if (currentActuatorState == LOW) {
        pwmDutyCycle = 200; 
    } else if (currentActuatorState == HIGH) {
        pwmDutyCycle = 1023; 
    }

    ledcWrite(ACTUATOR_PWM_CHANNEL, pwmDutyCycle);

    Serial.printf("[INTERRUPT] Actuated! State: %s (PWM: %d)\n",
                  currentActuatorState == HIGH ? "HIGH" : (currentActuatorState == LOW ? "LOW" : "OFF"),
                  pwmDutyCycle);

    if (serverClient.connected()) {
        serverClient.printf("ACK:%s\n", command.c_str());
    }
}