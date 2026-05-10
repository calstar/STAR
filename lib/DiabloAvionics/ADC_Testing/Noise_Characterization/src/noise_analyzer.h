#pragma once
#include <Arduino.h>

class NoiseAnalyzer {
public:
    static const size_t WINDOW_SIZE = 1000;   // larger window for better statistics

    NoiseAnalyzer();

    // Reset the analyzer (clear all samples)
    void reset();

    // Push a new raw ADC code (signed or unsigned)
    void addSample(int32_t code);

    // True once we've collected WINDOW_SIZE samples
    bool ready() const { return _count >= WINDOW_SIZE; }
    
    // Get current number of samples collected
    size_t sampleCount() const { return _count; }

    // === Noise Metrics ===
    
    // RMS noise in LSB (standard deviation of codes)
    float rmsNoiseLsb() const;
    
    // Peak-to-peak noise in LSB (max - min over window)
    float peakToPeakNoiseLsb() const;
    
    // Noise-free bits (based on RMS noise)
    // This is the number of bits that are not affected by noise
    float noiseFreeBits(uint8_t adcBits) const;
    
    // Effective Number of Bits (ENOB) - per ADC datasheet
    // ENOB = log2(FSR / Vn,rms) = adcBits - log2(RMS_noise_LSB)
    // Standard metric for ADC performance
    float enob(uint8_t adcBits) const;
    
    // Mean ADC code over the window
    double mean() const;
    
    // Check if signal appears stable (coefficient of variation < threshold)
    // Returns true if the noise is small relative to signal magnitude
    bool isStable(float cvThreshold = 0.01f) const;

private:
    int32_t _buf[WINDOW_SIZE];
    size_t  _count;
    size_t  _index;
    
    // Cached statistics (computed on-demand)
    mutable bool _statsDirty;
    mutable double _cachedMean;
    mutable double _cachedStdDev;
    mutable int32_t _cachedMin;
    mutable int32_t _cachedMax;
    
    // Update cached statistics if needed
    void _updateStats() const;
};
