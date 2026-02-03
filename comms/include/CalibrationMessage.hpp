#ifndef CALIBRATION_MESSAGE_HPP
#define CALIBRATION_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief Calibration Message
 *
 * Contains calibration status and results for sensors and encoders
 */
using CalibrationMessage =
    comms::CommsMessage<double,     // (0) timestamp (s) - timestamp
                   uint8_t,    // (1) sensor_id - sensor identifier
                   uint8_t,    // (2) sensor_type - sensor type (PT, RTD, TC, etc.)
                   uint8_t,    // (3) calibration_status - calibration status
                   double,     // (4) calibration_quality (0-1) - calibration quality
                   double,     // (5) rmse - root mean square error
                   double,     // (6) nrmse - normalized RMSE
                   double,     // (7) coverage_95 - 95% confidence interval coverage
                   double,     // (8) extrapolation_confidence - extrapolation confidence
                   uint32_t,   // (9) num_calibration_points - number of calibration points
                   double,     // (10) drift_detected - drift detection flag
                   bool,       // (11) calibration_valid - calibration validity
                   double,     // (12) last_calibration_time - last calibration timestamp
                   uint8_t,    // (13) sensor_health - sensor health status
                   uint64_t>;  // (14) time_monotonic (ns) - monotonic timestamp

// Function to set calibration measurements
static void set_calibration_measurement(CalibrationMessage& message, double timestamp,
                                        uint8_t sensor_id, uint8_t sensor_type,
                                        uint8_t calibration_status, double calibration_quality,
                                        double rmse, double nrmse, double coverage_95,
                                        double extrapolation_confidence,
                                        uint32_t num_calibration_points, double drift_detected,
                                        bool calibration_valid, double last_calibration_time,
                                        uint8_t sensor_health, uint64_t time_monotonic) {
    message.setField<0>(timestamp);
    message.setField<1>(sensor_id);
    message.setField<2>(sensor_type);
    message.setField<3>(calibration_status);
    message.setField<4>(calibration_quality);
    message.setField<5>(rmse);
    message.setField<6>(nrmse);
    message.setField<7>(coverage_95);
    message.setField<8>(extrapolation_confidence);
    message.setField<9>(num_calibration_points);
    message.setField<10>(drift_detected);
    message.setField<11>(calibration_valid);
    message.setField<12>(last_calibration_time);
    message.setField<13>(sensor_health);
    message.setField<14>(time_monotonic);
}

static CalibrationMessage generateTestMessageCalibration() {
    CalibrationMessage message;
    set_calibration_measurement(message, 0.0, 1, 0, 2, 0.95, 10.0, 0.01, 0.95, 0.9, 100, 0.0, true,
                                0.0, 0, 0);
    return message;
}

#endif  // CALIBRATION_MESSAGE_HPP
