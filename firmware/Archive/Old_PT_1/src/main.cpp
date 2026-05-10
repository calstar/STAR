#include "Arduino.h"
#include <Wire.h>
#include "EthernetHandler.h"


// Sampling + Buffer
const uint32_t samplePeriodMs = 25;
const size_t numChannels = 10;

struct __attribute__((packed)) Frame {
  uint32_t ts_ms;
  uint16_t ch[numChannels];
};

