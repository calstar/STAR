#include "STAR_ADS126X.h"

#define READINGS_PER_CHUNK 5
#define FILTER ADS126X_SINC4
#define DATA_RATE ADS126X_RATE_7200

// ADC Reference Configuration
// Set to 1 to use VDD as reference, 0 to use internal 2.5V reference
#define USE_VDD_REFERENCE 1
