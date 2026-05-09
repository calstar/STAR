// ESP32 Real-Time Current Monitoring and Actuator Control System
// Multi-Actuator Support with Config-Based Setup

// --- Library Includes ---
#include <Arduino.h>
#include "actuator_config.h"

// Timing configuration for the main loop sensor reading
const long SENSOR_READ_INTERVAL_MS = 500; // Read sensors every 500ms
unsigned long lastSensorReadTime = 0;

// --- Actuator State Management ---
enum ActuatorState {
    ACTUATOR_OFF,
    ACTUATOR_LOW,
    ACTUATOR_HIGH
};

struct Actuator {
    ActuatorState state;
    int pwmDutyCycle;
    float sensorValue;  // Current sensor reading (voltage or current)
    int pwmChannel;     // LEDC channel number (0-15)
};

Actuator actuators[NUM_ACTUATORS];
bool statusChanged = false; // Flag to send status update

// --- Function Declarations ---
void readAllSensors();
float readSensor(int pin);
void handleSerialCommands(); 
void decodeAndActuate(String command);
void printHelp();
void sendActuatorList();
void sendStatusUpdate();
void setActuatorState(int index, ActuatorState state);
const char* stateToString(ActuatorState state);

// --------------------------------------------------------------------------------
// SETUP
// --------------------------------------------------------------------------------
void setup() {
    Serial.begin(115200);
    
    // Wait longer for Serial to be ready (especially important on ESP32-S3)
    delay(1000);
    
    // Send a clear startup message
    Serial.println();
    Serial.println("========================================");
    Serial.println("ESP32 Multi-Actuator Control System");
    Serial.println("Serial Mode - 115200 baud");
    Serial.println("========================================");
    Serial.flush();
    delay(100);
    
    Serial.printf("Initializing %d actuators...\n", NUM_ACTUATORS);
    Serial.flush();

    // Initialize all actuators using PWM channels 0-9
    for (int i = 0; i < NUM_ACTUATORS; i++) {
        const ActuatorConfig& config = ACTUATORS[i];
        int channel = i;  // Use actuator index as PWM channel (0-9)
        
        // Setup PWM channel
        ledcSetup(channel, config.pwm_frequency, config.pwm_resolution);
        // Attach pin to channel
        ledcAttachPin(config.output_pin, channel);
        // Set initial duty cycle to OFF
        ledcWrite(channel, PWM_OFF);
        
        // Store channel number
        actuators[i].pwmChannel = channel;
        
        // Initialize sensor pin
        pinMode(config.sensor_pin, INPUT);
        
        // Initialize state
        actuators[i].state = ACTUATOR_OFF;
        actuators[i].pwmDutyCycle = PWM_OFF;
        actuators[i].sensorValue = 0.0;
        
        Serial.printf("  [%d] %s - Output: GPIO%d, Sensor: GPIO%d, PWM Ch: %d\n", 
                      i, config.name, config.output_pin, config.sensor_pin, channel);
    }
    
    Serial.println("All actuators initialized. Starting in OFF state.");
    Serial.println("Ready for commands via Serial.");
    Serial.println("Type 'REQ:ACTUATORS' to get actuator list");
    Serial.flush(); // Ensure all startup messages are sent
    delay(100);
    
    // Print help message
    printHelp();
    Serial.flush();
    delay(100);
    
    // Send a ready signal
    Serial.println("[SYSTEM] Setup complete. System ready.");
    Serial.flush();
}

// --------------------------------------------------------------------------------
// LOOP
// --------------------------------------------------------------------------------
void loop() {
    // 1. Check for Serial commands (HIGH PRIORITY - check first)
    handleSerialCommands();

    // 2. Send status update if changed
    if (statusChanged) {
        sendStatusUpdate();
        statusChanged = false;
    }

    // 3. PERIODIC SENSOR READING (cycle through all actuators)
    // NOTE: Reduced frequency to prevent Serial buffer overflow
    unsigned long currentTime = millis();
    if (currentTime - lastSensorReadTime >= SENSOR_READ_INTERVAL_MS) {
        lastSensorReadTime = currentTime;
        readAllSensors();
        // Don't flush here - let commands have priority
    }
    
    // Small delay to prevent tight loop from blocking Serial
    delay(1);
}

// --------------------------------------------------------------------------------
// UTILITY FUNCTIONS
// --------------------------------------------------------------------------------

void readAllSensors() {
    // Read sensor values for all actuators
    // NOTE: Reduced Serial output to prevent buffer overflow
    for (int i = 0; i < NUM_ACTUATORS; i++) {
        const ActuatorConfig& config = ACTUATORS[i];
        float sensorValue = readSensor(config.sensor_pin);
        actuators[i].sensorValue = sensorValue;
        
        // Only print sensor readings occasionally to avoid filling Serial buffer
        // Uncomment for debugging: Serial.printf("[SENSOR] Actuator %s: %.3f V\n", config.name, sensorValue);
    }
}

float readSensor(int pin) {
    int rawValue = analogRead(pin);
    // Convert ADC reading to voltage (ESP32 ADC: 0-4095 -> 0-3.3V)
    // Adjust this conversion based on your actual sensor characteristics
    float voltage = (float)rawValue * (3.3 / 4095.0);
    return voltage;
}

void handleSerialCommands() {
    // Check if data is available - read ALL available data
    while (Serial.available() > 0) {
        // Read the entire line at once using readStringUntil (more reliable)
        String command = Serial.readStringUntil('\n');
        command.trim();
        
        // Also remove carriage return if present
        command.replace("\r", "");
        command.trim();
        
        if (command.length() > 0) {
            Serial.printf("[CMD] Received: '%s' (len=%d)\n", command.c_str(), command.length());
            Serial.flush(); // Flush immediately after receiving command
            
            // Check for help command
            if (command.equalsIgnoreCase("HELP") || command.equalsIgnoreCase("?")) {
                printHelp();
                Serial.flush();
            } 
            // Request actuator list
            else if (command.equalsIgnoreCase("REQ:ACTUATORS")) {
                Serial.println("[CMD] Processing REQ:ACTUATORS");
                Serial.flush();
                delay(10); // Small delay to ensure flush completes
                sendActuatorList();
            }
            // Request status
            else if (command.equalsIgnoreCase("REQ:STATUS")) {
                Serial.println("[CMD] Processing REQ:STATUS");
                Serial.flush();
                delay(10);
                sendStatusUpdate();
            }
            // Try to decode and actuate
            else {
                decodeAndActuate(command);
                Serial.flush();
            }
        }
    }
}

void sendActuatorList() {
    // Build the response string first
    String response = "RESP:ACTUATORS:";
    for (int i = 0; i < NUM_ACTUATORS; i++) {
        response += ACTUATORS[i].name;
        if (i < NUM_ACTUATORS - 1) {
            response += ",";
        }
    }
    response += "\n";
    
    // Send it all at once
    Serial.print(response);
    Serial.flush(); // CRITICAL: Force immediate send
    
    // Small delay to ensure transmission completes
    delay(10);
}

void sendStatusUpdate() {
    Serial.print("STATUS:RESP:");
    for (int i = 0; i < NUM_ACTUATORS; i++) {
        // Format: index:state:sensor_value
        Serial.printf("%d:%s:%.3f", i, stateToString(actuators[i].state), actuators[i].sensorValue);
        if (i < NUM_ACTUATORS - 1) {
            Serial.print(",");
        }
    }
    Serial.println(); // This adds \n
    Serial.flush(); // Ensure it's sent immediately
}

void setActuatorState(int index, ActuatorState state) {
    if (index < 0 || index >= NUM_ACTUATORS) {
        Serial.printf("[ERROR] Invalid actuator index: %d\n", index);
        return;
    }
    
    const ActuatorConfig& config = ACTUATORS[index];
    int pwmDutyCycle = 0;
    
    switch (state) {
        case ACTUATOR_OFF:
            pwmDutyCycle = PWM_OFF;
            break;
        case ACTUATOR_LOW:
            pwmDutyCycle = PWM_LOW;
            break;
        case ACTUATOR_HIGH:
            pwmDutyCycle = PWM_HIGH;
            break;
    }
    
    // Only update if state actually changed
    if (actuators[index].state != state) {
        actuators[index].state = state;
        actuators[index].pwmDutyCycle = pwmDutyCycle;
        
        // Write to PWM channel
        ledcWrite(actuators[index].pwmChannel, pwmDutyCycle);
        
        Serial.printf("[ACTUATE] %s -> %s (PWM: %d, Pin: %d)\n", 
                      config.name, stateToString(state), pwmDutyCycle, config.output_pin);
        
        // Mark that status changed - will send update in loop()
        statusChanged = true;
    }
}

const char* stateToString(ActuatorState state) {
    switch (state) {
        case ACTUATOR_OFF: return "OFF";
        case ACTUATOR_LOW: return "LOW";
        case ACTUATOR_HIGH: return "HIGH";
        default: return "UNKNOWN";
    }
}

void printHelp() {
    Serial.println("\n--- Available Commands ---");
    Serial.println("REQ:ACTUATORS  - Request list of actuator names");
    Serial.println("REQ:STATUS      - Request current status of all actuators");
    Serial.println("ACTUATE:<idx>:<state> - Control actuator (state: OFF, LOW, HIGH)");
    Serial.println("  Example: ACTUATE:0:HIGH");
    Serial.println("HELP or ?       - Show this help message");
    Serial.println("--------------------------\n");
}

void decodeAndActuate(String command) {
    // Parse command: ACTUATE:<index>:<state>
    if (command.startsWith("ACTUATE:")) {
        int colon1 = command.indexOf(':', 8); // Find second colon after "ACTUATE:"
        if (colon1 == -1) {
            Serial.println("[ERROR] Invalid ACTUATE command format. Use: ACTUATE:<index>:<state>");
            return;
        }
        
        String indexStr = command.substring(8, colon1);
        String stateStr = command.substring(colon1 + 1);
        stateStr.toUpperCase();
        
        int index = indexStr.toInt();
        ActuatorState state;
        
        if (stateStr.equals("OFF")) {
            state = ACTUATOR_OFF;
        } else if (stateStr.equals("LOW")) {
            state = ACTUATOR_LOW;
        } else if (stateStr.equals("HIGH")) {
            state = ACTUATOR_HIGH;
        } else {
            Serial.printf("[ERROR] Invalid state: %s. Use OFF, LOW, or HIGH\n", stateStr.c_str());
            return;
        }
        
        setActuatorState(index, state);
    } else {
        Serial.println("[ERROR] Unknown command. Type HELP for available commands.");
    }
}
