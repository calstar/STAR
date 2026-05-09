#include "STAR_ADS126X.h"

#define READINGS_PER_CONNECTOR 5  // Readings per connector per chunk (allows settling)
#define FILTER ADS126X_SINC4
#define DATA_RATE ADS126X_RATE_1200

// ADC Reference: internal 2.5V (RTD typically uses internal reference).
// Raw codes are sent over the wire.
