#include "noise_analyzer.h"
#include <math.h>

NoiseAnalyzer::NoiseAnalyzer()
    : _count(0), _index(0), _statsDirty(true),
      _cachedMean(0.0), _cachedStdDev(0.0),
      _cachedMin(0), _cachedMax(0) {
    for (size_t i = 0; i < WINDOW_SIZE; ++i) {
        _buf[i] = 0;
    }
}

void NoiseAnalyzer::reset() {
    _count = 0;
    _index = 0;
    _statsDirty = true;
    _cachedMean = 0.0;
    _cachedStdDev = 0.0;
    _cachedMin = 0;
    _cachedMax = 0;
}

void NoiseAnalyzer::addSample(int32_t code) {
    _buf[_index] = code;
    _index = (_index + 1) % WINDOW_SIZE;
    if (_count < WINDOW_SIZE) _count++;
    _statsDirty = true;  // Mark stats as needing recalculation
}

void NoiseAnalyzer::_updateStats() const {
    if (!_statsDirty || _count == 0) return;
    
    // Calculate mean, min, max in one pass
    double sum = 0.0;
    int32_t minVal = _buf[0];
    int32_t maxVal = _buf[0];
    
    for (size_t i = 0; i < _count; ++i) {
        int32_t val = _buf[i];
        sum += (double)val;
        if (val < minVal) minVal = val;
        if (val > maxVal) maxVal = val;
    }
    
    _cachedMean = sum / (double)_count;
    _cachedMin = minVal;
    _cachedMax = maxVal;
    
    // Calculate standard deviation in second pass
    if (_count < 2) {
        _cachedStdDev = 0.0;
    } else {
        double sumSqDev = 0.0;
        for (size_t i = 0; i < _count; ++i) {
            double dev = (double)_buf[i] - _cachedMean;
            sumSqDev += dev * dev;
        }
        // Use unbiased estimator (N-1)
        _cachedStdDev = sqrt(sumSqDev / (double)(_count - 1));
    }
    
    _statsDirty = false;
}

double NoiseAnalyzer::mean() const {
    if (_count == 0) return NAN;
    _updateStats();
    return _cachedMean;
}

float NoiseAnalyzer::rmsNoiseLsb() const {
    if (_count < 2) return NAN;
    _updateStats();
    return (float)_cachedStdDev;
}

float NoiseAnalyzer::peakToPeakNoiseLsb() const {
    if (_count < 2) return NAN;
    _updateStats();
    return (float)(_cachedMax - _cachedMin);
}

float NoiseAnalyzer::noiseFreeBits(uint8_t adcBits) const {
    if (_count < 50) return NAN;  // Need at least 50 samples for good statistics

    float rms = rmsNoiseLsb();
    if (!isfinite(rms) || rms <= 0.0f) {
        return (float)adcBits;  // effectively no measurable noise
    }

    // Noise-free bits calculation:
    // Peak-to-peak noise ≈ 6.6 × RMS for Gaussian distribution (99.99% confidence)
    // NFB = log2(2^adcBits / noise_pp) = adcBits - log2(noise_pp)
    // NFB = adcBits - log2(6.6 × RMS)
    double noisePP = 6.6 * (double)rms;
    double nfb = (double)adcBits - log2(noisePP);

    // Clamp to reasonable range
    if (nfb < 0.0) nfb = 0.0;
    if (nfb > (double)adcBits) nfb = (double)adcBits;
    
    return (float)nfb;
}

float NoiseAnalyzer::enob(uint8_t adcBits) const {
    if (_count < 50) return NAN;  // Need at least 50 samples for good statistics

    float rms = rmsNoiseLsb();
    if (!isfinite(rms) || rms <= 0.0f) {
        return (float)adcBits;
    }

    // ENOB (Effective Number of Bits) per ADC datasheet:
    // ENOB = log2(FSR / Vn,rms)
    // 
    // Where:
    //   FSR = Full Scale Range = 2·VREF / gain (in volts)
    //   Vn,rms = RMS noise (in volts)
    //
    // When working with codes instead of voltages:
    //   FSR_codes = 2^adcBits
    //   Noise_codes = RMS_LSB
    //
    // Therefore:
    //   ENOB = log2(2^adcBits / RMS_LSB)
    //   ENOB = log2(2^adcBits) - log2(RMS_LSB)
    //   ENOB = adcBits - log2(RMS_LSB)
    
    double enobValue = (double)adcBits - log2((double)rms);

    // Clamp to reasonable range
    if (enobValue < 0.0) enobValue = 0.0;
    if (enobValue > (double)adcBits) enobValue = (double)adcBits;
    
    return (float)enobValue;
}

bool NoiseAnalyzer::isStable(float cvThreshold) const {
    if (_count < 10) return false;  // Need reasonable sample size
    
    _updateStats();
    
    // Check if mean is close to zero (avoid division by zero)
    // For ADC codes, we consider "near zero" as absolute value < 100
    if (fabs(_cachedMean) < 100.0) {
        // If mean is near zero, check if std dev is small (< 50 LSB)
        return _cachedStdDev < 50.0;
    }
    
    // Coefficient of Variation = StdDev / |Mean|
    double cv = _cachedStdDev / fabs(_cachedMean);
    return cv < (double)cvThreshold;
}
