#include <esp_now.h>
#include <WiFi.h>
#include <Wire.h>
#include <Arduino.h>

// Define pins for various sensors and connections
#define LED_BUILTIN 2
#define SENSOR 27
#define ONBOARD_LED 2
#define PT_UPSTREAM 25    // Upstream pressure
#define PT_TANK 26       // Tank pressure
#define PT_DOWNSTREAM 27  // Downstream pressure
#define PT_VENTURI_1 32  // Venturi inlet pressure
#define PT_VENTURI_2 35  // Venturi throat pressure
//#define PTDOUT3 35  // PT3 - Adjust pin as needed
#define SOLENOID_PIN_1 13
#define SOLENOID_PIN_2 12

// Initialize pressure sensor data var  iables
float pt1 = -1;
float pt2 = -1;
float pt3 = -1;
float pt4 = -1;
float pt5 = -1;

bool control_active = true;

// String to store incoming serial messages
String serialMessage = "";

void setup() {
  // Set up serial communication for debugging
  Serial.begin(115200);
  Serial.println("SETUP");
  
  // Set up sensor pins
  pinMode(PT_UPSTREAM, INPUT);
  pinMode(PT_TANK, INPUT);
  pinMode(PT_DOWNSTREAM, INPUT);
  pinMode(PT_VENTURI_1, INPUT);
  pinMode(PT_VENTURI_2, INPUT);
  
  // Set up solenoid pin as output and turn it on
  pinMode(SOLENOID_PIN_1, OUTPUT);
  digitalWrite(SOLENOID_PIN_1, HIGH);  // Keep the solenoid on
  pinMode(SOLENOID_PIN_2, OUTPUT);
  digitalWrite(SOLENOID_PIN_2, HIGH);  // Keep the solenoid on
  
  // Additional setup code for WiFi, ESP-NOW, etc. can be added here
}

void loop() {
  // Read sensor data from pins
  pt2 = analogRead(PT_UPSTREAM);
  pt3 = analogRead(PT_TANK);
  pt4 = analogRead(PT_DOWNSTREAM);
  pt5 = analogRead(PT_VENTURI_1);
  pt1 = analogRead(PT_VENTURI_2);
  
  // Print the sensor data for debugging
  Serial.print(pt1);
  Serial.println(" ");
  Serial.print(pt2);
  Serial.print(" ");
  Serial.print(pt3);
  Serial.print(" ");
  Serial.print(pt4);
  Serial.print(" ");
  Serial.print(pt5);
  Serial.print(" ");

  delay(100);
}
