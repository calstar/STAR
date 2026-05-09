#pragma once
#include <stdint.h>
#include <stddef.h>

// ---------- ADC config ----------
inline uint8_t neg_pin = 0x0A;              // AINCOM
inline float   vRef    = 2.5f;
inline float   adcScale = 2147483648.0f;     // 2^31, signed full-scale

// ---------- Channels ----------
inline uint8_t adc_channels[] = {2, 3};
inline size_t  num_channels = sizeof(adc_channels) / sizeof(adc_channels[0]);

// Channels for actuator
// actuator1_channels[] = {(name, 1), (OUP, 2)}
// actuator2_channels[]



/*
Old (Module 8) defines were duplicate/conflicting:
  #define DOUT 41 // MISO
  #define DIN 5   // MOSI
  #define SCLK 13
  #define CS 37
  #define START 43
Use the constants above instead. If you must keep them for legacy code:

#ifdef DOUT
#undef DOUT
#endif
#define DOUT MISO

#ifdef DIN
#undef DIN
#endif
#define DIN MOSI
*/
