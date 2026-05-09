#pragma once

#include <stdint.h>

#define ADS126X_TDAC 15
#define ADS126X_TDAC_DIV_0_6 1
#define ADS126X_TDAC_DIV_0_5 2
#define ADS126X_REF_NEG_VSS 3
#define ADS126X_REF_POS_VDD 4
#define ADS126X_IDAC_MAG_0 5
#define ADS126X_BIAS_ADC1 6
#define ADS126X_BIAS_PULLUP 7
#define ADS126X_BIAS_MAG_10M 8
#define ADS126X_BIAS_MAG_0 9

struct ads126x_reading {
    int32_t value;
    bool checksumValid;
};

// Global mocks for testing
extern int32_t g_mock_adc_value;
extern bool g_mock_adc_checksum;

class ADS126X {
public:
    void bypassPGA() {}
    void setInputMux(uint8_t pos, uint8_t neg) {}
    void setOutputTDACP(uint8_t on) {}
    void setOutputTDACN(uint8_t on) {}
    void setOutputmagnitudeTDACP(uint8_t mag) {}
    void setOutputmagnitudeTDACN(uint8_t mag) {}
    void setReference(uint8_t neg, uint8_t pos) {}
    
    ads126x_reading readADC1() {
        return {g_mock_adc_value, g_mock_adc_checksum};
    }
    
    void setIDAC1Mag(uint8_t mag) {}
    void setIDAC2Mag(uint8_t mag) {}
    void setBiasADC(uint8_t adc) {}
    void setBiasPolarity(uint8_t pol) {}
    void setBiasMagnitude(uint8_t mag) {}
    void stopADC1() {}
    void startADC1() {}
};
