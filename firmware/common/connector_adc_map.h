#pragma once

#include <cstddef>
#include <cstdint>
#include "STAR_ADS126X.h"
#include "sense_board_pins.h"

struct ConnectorAdcMapEntry {
    uint8_t connector;   // e.g. 1 = J1, 2 = J2
    uint8_t pin;         // e.g. 1 = Jx-1, 2 = Jx-2
    uint8_t adc;         // e.g. ADS126X_AIN0 = 0b0000
    uint8_t adc_index;   // 1 = primary ADC, 2 = secondary ADC, etc.
};

struct AdcSelection {
    int channel;
    int adc_index;
};

struct AdcLayout {
    const ConnectorAdcMapEntry* table;
    std::size_t size;

    constexpr AdcSelection get(uint8_t connector, uint8_t pin) const {
        for (std::size_t i = 0; i < size; ++i) {
            const auto& e = table[i];
            if (e.connector == connector && e.pin == pin)
                return {e.adc, e.adc_index}; // raw integer channel + adc index
        }
        return {-1, -1};                // invalid
    }
};

namespace sense_board_pins {

// PT Board
inline constexpr ConnectorAdcMapEntry PT_Board_AdcEntries[] = {
    // connector, pin, adc channel, adc index
    { 1, 1, ADS126X_AIN0, 1},
    { 2, 1, ADS126X_AIN1, 1},
    { 3, 1, ADS126X_AIN7, 1},
    { 4, 1, ADS126X_AIN5, 1},
    { 5, 1, ADS126X_AIN9, 1},
    { 6, 1, ADS126X_AIN2, 1},
    { 7, 1, ADS126X_AIN3, 1},
    { 8, 1, ADS126X_AIN4, 1},
    { 9, 1, ADS126X_AIN6, 1},
    { 10, 1, ADS126X_AIN8, 1},
};

inline constexpr AdcLayout PT_Board_Adc = {
    PT_Board_AdcEntries,
    sizeof(PT_Board_AdcEntries) / sizeof(PT_Board_AdcEntries[0]),
};

// LC Board
inline constexpr ConnectorAdcMapEntry LC_Board_AdcEntries[] = {
    // connector, pin, adc channel, adc index
    { 1, 1, ADS126X_AIN0, 1},
    { 1, 2, ADS126X_AIN1, 1},
    { 2, 1, ADS126X_AIN4, 1},
    { 2, 2, ADS126X_AIN5, 1},
    { 3, 1, ADS126X_AIN8, 1},
    { 3, 2, ADS126X_AIN9, 1},
    { 6, 1, ADS126X_AIN2, 1},
    { 6, 2, ADS126X_AIN3, 1},
    { 7, 1, ADS126X_AIN6, 1},
    { 7, 2, ADS126X_AIN7, 1},

    { 4, 1, ADS126X_AIN2, 2},
    { 4, 2, ADS126X_AIN3, 2},
    { 5, 1, ADS126X_AIN6, 2},
    { 5, 2, ADS126X_AIN7, 2},
    { 8, 1, ADS126X_AIN0, 2},
    { 8, 2, ADS126X_AIN1, 2},
    { 9, 1, ADS126X_AIN4, 2},
    { 9, 2, ADS126X_AIN5, 2},
    { 10, 1, ADS126X_AIN8, 2},
    { 10, 2, ADS126X_AIN9, 2},
};

inline constexpr AdcLayout LC_Board_Adc = {
    LC_Board_AdcEntries,
    sizeof(LC_Board_AdcEntries) / sizeof(LC_Board_AdcEntries[0]),
};

// TC Board
inline constexpr ConnectorAdcMapEntry TC_Board_AdcEntries[] = {
    // connector, pin, adc channel, adc index
    { 1, 1, ADS126X_AIN0, 1},
    { 2, 1, ADS126X_AIN2, 1},
    { 3, 1, ADS126X_AIN4, 1},
    { 4, 1, ADS126X_AIN6, 1},
    { 5, 1, ADS126X_AIN8, 1},
    { 6, 1, ADS126X_AIN1, 1},
    { 7, 1, ADS126X_AIN3, 1},
    { 8, 1, ADS126X_AIN5, 1},
    { 9, 1, ADS126X_AIN7, 1},
    { 10, 1, ADS126X_AIN9, 1},
};

inline constexpr AdcLayout TC_Board_Adc = {
    TC_Board_AdcEntries,
    sizeof(TC_Board_AdcEntries) / sizeof(TC_Board_AdcEntries[0]),
};

// RTD Board
inline constexpr ConnectorAdcMapEntry RTD_Board_AdcEntries[] = {
    // connector, pin, adc channel, adc index
    { 1, 1, ADS126X_AIN2, 1},
    { 1, 2, ADS126X_AIN3, 1},
    { 1, 101, ADS126X_AIN1, 1}, // IDAC1, corresponding to the pin 1
    { 1, 102, ADS126X_AIN4, 1}, // IDAC2, corresponding to the pin 2

    { 2, 1, ADS126X_AIN6, 1},
    { 2, 2, ADS126X_AIN7, 1},
    { 2, 101, ADS126X_AIN5, 1}, // IDAC1
    { 2, 102, ADS126X_AIN8, 1}, // IDAC2

    { 3, 1, ADS126X_AIN2, 2},
    { 3, 2, ADS126X_AIN3, 2},
    { 3, 101, ADS126X_AIN1, 2}, // IDAC1
    { 3, 102, ADS126X_AIN4, 2}, // IDAC2
    
    { 4, 1, ADS126X_AIN6, 2},
    { 4, 2, ADS126X_AIN7, 2},
    { 4, 101, ADS126X_AIN5, 2}, // IDAC1
    { 4, 102, ADS126X_AIN8, 2}, // IDAC2
};

inline constexpr AdcLayout RTD_Board_Adc = {
    RTD_Board_AdcEntries,
    sizeof(RTD_Board_AdcEntries) / sizeof(RTD_Board_AdcEntries[0]),
};

// Set to a default value, if it was forgotten
#ifndef PINS_ACTIVE_LAYOUT
#define PINS_ACTIVE_LAYOUT PT_Board
#endif

// Some ChatGPT bullshit to let us reuse the "PINS_ACTIVE_LAYOUT" macro
#define ADC_LAYOUT_CAT_IMPL(a, b) a##b
#define ADC_LAYOUT_CAT(a, b)      ADC_LAYOUT_CAT_IMPL(a, b)
#define ADC_LAYOUT_FROM_PINS(layout_sym) ADC_LAYOUT_CAT(layout_sym, _Adc)
inline constexpr const AdcLayout& AdcMap = ADC_LAYOUT_FROM_PINS(PINS_ACTIVE_LAYOUT);

// Function to get adc channel (-1 if invalid)
constexpr int getAdcChannel(uint8_t connector, uint8_t pin) {
    // To avoid someone trying to get the IDAC intended pins on the 
    // RTD board as ADC channels that should be read
    if (pin > 100) {
        return -1;
    }

    return AdcMap.get(connector, pin).channel;
}

// Function to get adc channel for idac intended pins (-1 if invalid)
constexpr int getIdacChannel(uint8_t connector, uint8_t pin) { 
    // Look there are reasons we did this but they are hard to explain 
    // We set the pin number for the IDAC channels to be + 100 since it was the cleanest way
    return AdcMap.get(connector, pin + 100).channel;
}

// Function to get adc index (1-based, -1 if invalid)
constexpr int getAdcIndex(uint8_t connector, uint8_t pin) {
    return AdcMap.get(connector, pin).adc_index;
}

}
