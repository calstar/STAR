#ifndef ACTUATOR_CONFIG_H
#define ACTUATOR_CONFIG_H

// Actuator Configuration
// Define your actuators here with their names and pin assignments

#define NUM_ACTUATORS 10

// Actuator definitions: {name, output_pin, sensor_pin, pwm_channel}
// PWM channels must be unique (0-15 on ESP32)
// Output pins: PWM control pins for actuators
// Sensor pins: ADC input pins for reading sensor values
struct ActuatorConfig {
    const char* name;
    int output_pin;      // PWM output pin (GPIO)
    int sensor_pin;      // ADC input pin (GPIO) for sensor reading
    int pwm_channel;
    int pwm_frequency;
    int pwm_resolution;
};

// Define your actuators here
// Format: {name, output_pin, sensor_pin, pwm_channel, frequency, resolution}
// Sensor pins (ADC): GPIO18, GPIO17, GPIO09, GPIO08, GPIO13, GPIO10, GPIO11, GPIO12, GPIO01, GPIO02
// Output pins (PWM): GPIO07, GPIO06, GPIO05, GPIO04, GPIO48, GPIO47, GPIO21, GPIO14, GPIO36, GPIO35
// Mapping: 1->7, 2->2, 3->6, 4->1, 5->9, 6->4, 7->8, 8->3, 9->5, 10->10
static const ActuatorConfig ACTUATORS[NUM_ACTUATORS] = {
    {"7", 7,  18, 0, 5000, 10},  // Position 1, named "7": Output=GPIO07, Sensor=GPIO18
    {"2", 6,  17, 1, 5000, 10},  // Position 2, named "2": Output=GPIO06, Sensor=GPIO17
    {"6", 5,  9,  2, 5000, 10},  // Position 3, named "6": Output=GPIO05, Sensor=GPIO09
    {"1", 4,  8,  3, 5000, 10},  // Position 4, named "1": Output=GPIO04, Sensor=GPIO08
    {"9", 48, 13, 4, 5000, 10},  // Position 5, named "9": Output=GPIO48, Sensor=GPIO13
    {"4", 47, 10, 5, 5000, 10},  // Position 6, named "4": Output=GPIO47, Sensor=GPIO10
    {"8", 21, 11, 6, 5000, 10},  // Position 7, named "8": Output=GPIO21, Sensor=GPIO11
    {"3", 14, 12, 7, 5000, 10},  // Position 8, named "3": Output=GPIO14, Sensor=GPIO12
    {"5", 36, 1,  8, 5000, 10},  // Position 9, named "5": Output=GPIO36, Sensor=GPIO01
    {"10", 35, 2, 9, 5000, 10}   // Position 10, named "10": Output=GPIO35, Sensor=GPIO02
};

// PWM duty cycle values for different states
#define PWM_OFF   0
#define PWM_LOW   200
#define PWM_HIGH  1023

#endif // ACTUATOR_CONFIG_H

