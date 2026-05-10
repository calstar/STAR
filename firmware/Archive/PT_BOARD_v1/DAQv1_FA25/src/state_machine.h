#include <MCP23S17.h>
#include <ADS126X.h>
#include <SPI.h>
//#include <solenoid_control.h>


enum STATES { 
  IDLE,
  ARMED,
  PRESS,
  PRESS2,
  ABORT,
  FILL,
  FIRE
};

int STATES[] = {IDLE, ARMED, PRESS, PRESS2, ABORT, FILL, FIRE};

String state_names[] = { "Idle", "Armed", "Press","Press2", "Abort", "Fill", "Fire" };

ADS126X SENSE_1;
ADS126X SENSE_2;



struct Pressures {
  float P_pressurant; // pressurant tank
  float P_up;         // upstream manifold (shared)
  float P_fuel;       // fuel tank
  float P_lox;        // LOX tank
  float P_fd;         // fuel downstream
  float P_ld;         // LOX downstream
  float P_inj;        // injector
};
Pressures gP;


// int DAQState = IDLE;
// int COMState = IDLE;
// int FlightState = IDLE;

// bool ethComplete = false;
// bool oxComplete = false;
// bool oxVentComplete = false;
// bool ethVentComplete = false;

// bool pressureTankComplete = false;
// bool fuelPressComplete = false;
// bool oxPressComplete = false;
// bool ventComplete = false;
// bool pressureReregComplete = false;

// float p_fuel_up_filtered;
// float p_fuel_down_filtered;


//bool flight_toggle = false;

// Pressure thresholds
float pressureTankTarget = 150;    // Target pressure for pressure tank
float pressureFuel = 495;          // Target pressure for fuel tank
float pressureOx = 465;            // Target pressure for LOX tank
float abortPressure = 800;         // Pressure threshold for abort condition
float threshold = 0.98;            // Re-pressurization threshold
float ventTo = 5;                  // Close solenoids at this pressure to preserve lifetime





// System parameters from optimization paper
const float ALPHA = 0.1;        // Natural pressure loss rate
const float BETA = 0.5;         // Upstream control penalty
const float DELTA = 0.5;        // Downstream control penalty
const float GAMMA = 0.3;        // Oscillatory control weight
const float LAMBDA = 0.2;       // Instability penalty

// Control states
enum ControlState {
    NOMINAL_REGULATION,
    RECOVERY_DAMPING,
    HIGH_FREQUENCY_OSCILLATION
};

const char* stateStrings[] = {
    "NOMINAL",
    "RECOVERY",
    "OSCILLATION"
};


// Moving average filter
const int FILTER_WINDOW = 20;
float pressure_buffer[8][FILTER_WINDOW];
int buffer_index = 0;

// System state variables
ControlState current_fuel_state = NOMINAL_REGULATION;
float P_threshold_fuel_base = 50.0;
float P_threshold_fuel_down;
float P_threshold_fuel_current;
float P_fuel;
float dP_fuel_dt;
float P_threshold_fuel_up;  // Upstream fuel pressure threshold
float P_threshold_fuel_up_base = P_threshold_fuel_base;

ControlState current_lox_state = NOMINAL_REGULATION;
float P_threshold_lox_base = 50.0; // Adjust base threshold for LOX as needed
float P_threshold_lox_down;
float P_threshold_lox_up;
float P_threshold_lox_current;
float p_lox_up_filtered;
float p_lox_down_filtered;
float P_lox;
float dP_lox_dt;
float P_threshold_lox_up_base = P_threshold_lox_base; // Higher base threshold for upstream LOX


unsigned long last_update = 0;
const int UPDATE_INTERVAL = 50; // 50ms update interval
const unsigned long deltaT = 1000;  // 0.1s in milliseconds

// Threshold optimization parameters
const float DT = UPDATE_INTERVAL / 1000.0;  // Convert to seconds
const float K_P = 0.8;  // Proportional gain
const float K_I = 0.2;  // Integral gain
const float K_D = 0.3;  // Derivative gain
const float MAX_THRESHOLD_CHANGE = 25;
const float STABILITY_EPSILON = 5.0;

// PID state variables
float last_pressure_error_fuel = 0;
float integral_error_fuel = 0;
float last_pressure_error_fuel_up = 0;
float integral_error_fuel_up = 0;

float last_pressure_error_lox = 0;
float integral_error_lox = 0;
float last_pressure_error_lox_up = 0;
float integral_error_lox_up = 0;

// Calibration coefficients
// Pressure Transducer Calibration Coefficients
// const float PT_P_A = -5.44825017487633E-09;
// const float PT_P_B = 0.0000165145288612233;
// const float PT_P_C = 0.17643609939829;
// const float PT_P_D = -99.5214963852045;

// const float PT_F1_A = -3.05918799222961E-08;
// const float PT_F1_B = 0.0000865416133942164;
// const float PT_F1_C = 0.123902391819258;
// const float PT_F1_D = -80.7759908639505;

// const float PT_O1_A = -5.59024700297979E-10;
// const float PT_O1_B =  2.95030660576259E-06;
// const float PT_O1_C = 0.192622978835518;
// const float PT_O1_D = -86.2447994854917;

// const float PT_F2_A = 1.76851377283004E-08;
// const float PT_F2_B = -0.0000463856993688005;
// const float PT_F2_C = 0.23275478320493;
// const float PT_F2_D = -97.2678935373566;

// const float PT_O2_A = 8.37809910938362E-10;
// const float PT_O2_B =  8.49581367227712E-06;
// const float PT_O2_C = 0.183688920248558;
// const float PT_O2_D =  -70.1194944330298;

// LOX pressure transducers calibration - replace with actual coefficients
// const float PT_I_A = -5.44825017487633E-09; // Replace with actual calibration data
// const float PT_I_B = 0.0000165145288612233;
// const float PT_I_C = 0.17643609939829;
// const float PT_I_D = -99.5214963852045;

// bool upstream_solenoid_state = false; //CHANGE TO FUEL
// bool downstream_solenoid_state = false;
// bool lox_upstream_solenoid_state = false;
// bool lox_downstream_solenoid_state = false;

float calculatePressure(float raw_value, float PT_A, float PT_B, float PT_C, float PT_D);
