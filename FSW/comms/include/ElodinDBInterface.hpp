/**
 * @file ElodinDBInterface.hpp
 * @brief Elodin DB interface for real-time calibration visualization
 *
 * This interface provides:
 * 1. Real-time data streaming to Elodin DB
 * 2. Calibration convergence tracking
 * 3. Variance reduction visualization
 * 4. Interactive plots for human-in-the-loop calibration
 */

#ifndef ELODIN_DB_INTERFACE_HPP
#define ELODIN_DB_INTERFACE_HPP

#include <Eigen/Core>
#include <Eigen/Dense>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>

// Forward declarations
struct CalibrationParameters;

/**
 * @brief Data point for Elodin DB streaming
 */
struct ElodinDataPoint {
    std::string sensor_id;
    std::string
        data_type;  // "raw_adc", "voltage", "pressure", "calibration_param", "variance", etc.
    double value;
    std::string unit;  // "counts", "V", "Pa", "dimensionless", etc.
    uint64_t timestamp_ns;
    std::map<std::string, double> metadata;  // Additional metadata (environmental conditions, etc.)

    ElodinDataPoint() : value(0.0), timestamp_ns(0) {
    }

    ElodinDataPoint(const std::string& id, const std::string& type, double val,
                    const std::string& u, uint64_t ts)
        : sensor_id(id), data_type(type), value(val), unit(u), timestamp_ns(ts) {
    }
};

/**
 * @brief Calibration convergence tracking data
 */
struct CalibrationConvergenceData {
    std::string sensor_id;
    uint64_t timestamp_ns;
    int calibration_iteration;
    Eigen::VectorXd theta_parameters;
    Eigen::MatrixXd parameter_covariance;
    double confidence_score;
    double nrmse;
    double coverage_95;
    // EnvironmentalState environmental_conditions; // Will be included in implementation

    CalibrationConvergenceData()
        : calibration_iteration(0), confidence_score(0.0), nrmse(0.0), coverage_95(0.0) {
    }
};

/**
 * @brief Real-time calibration visualization interface
 */
class ElodinDBInterface {
public:
    /**
     * @brief Configuration for Elodin DB connection
     */
    struct ElodinConfig {
        std::string host = "localhost";
        int port = 8080;
        std::string database_name = "pt_calibration";
        std::string username = "calibration_user";
        std::string password = "";
        bool enable_ssl = false;
        int batch_size = 100;          // Number of points to batch before sending
        int flush_interval_ms = 1000;  // Flush interval in milliseconds
        bool enable_compression = true;
        std::string time_series_table = "calibration_data";
        std::string convergence_table = "convergence_metrics";
    };

    ElodinDBInterface(const ElodinConfig& config);
    ~ElodinDBInterface();

    /**
     * @brief Initialize connection to Elodin DB
     */
    bool initialize();

    /**
     * @brief Start the background streaming thread
     */
    bool start();

    /**
     * @brief Stop the background streaming thread
     */
    void stop();

    /**
     * @brief Stream raw ADC data point
     */
    void streamRawADC(const std::string& sensor_id, int32_t raw_adc, uint64_t timestamp_ns);

    /**
     * @brief Stream voltage data point
     */
    void streamVoltage(const std::string& sensor_id, double voltage, uint64_t timestamp_ns);

    /**
     * @brief Stream pressure data point
     */
    void streamPressure(const std::string& sensor_id, double pressure_pa, uint64_t timestamp_ns);

    /**
     * @brief Stream calibration parameter updates
     */
    void streamCalibrationParameters(const std::string& sensor_id,
                                     const CalibrationParameters& params, uint64_t timestamp_ns);

    /**
     * @brief Stream calibration convergence data
     */
    void streamCalibrationConvergence(const CalibrationConvergenceData& convergence_data);

    /**
     * @brief Stream environmental conditions
     */
    void streamEnvironmentalConditions(const std::string& sensor_id,
                                       const void* environment,  // EnvironmentalState
                                       uint64_t timestamp_ns);

    /**
     * @brief Stream human-in-the-loop feedback
     */
    void streamHumanFeedback(const std::string& sensor_id, double reference_pressure,
                             double measured_voltage, bool accepted_calibration,
                             uint64_t timestamp_ns);

    /**
     * @brief Create real-time calibration plot
     */
    void createCalibrationPlot(const std::string& sensor_id, const std::string& plot_title = "");

    /**
     * @brief Create convergence tracking plot
     */
    void createConvergencePlot(const std::string& sensor_id, const std::string& plot_title = "");

    /**
     * @brief Create variance reduction plot
     */
    void createVariancePlot(const std::string& sensor_id, const std::string& plot_title = "");

    /**
     * @brief Get connection status
     */
    bool isConnected() const {
        return connected_;
    }

    /**
     * @brief Get streaming statistics
     */
    struct StreamingStats {
        uint64_t total_points_sent;
        uint64_t total_batches_sent;
        uint64_t failed_sends;
        uint64_t queue_size;
        double avg_latency_ms;
    };

    StreamingStats getStreamingStats() const;

private:
    ElodinConfig config_;
    std::atomic<bool> running_;
    std::atomic<bool> connected_;

    // Background streaming thread
    std::thread streaming_thread_;
    std::queue<ElodinDataPoint> data_queue_;
    std::mutex queue_mutex_;
    std::condition_variable queue_cv_;

    // Statistics
    mutable std::mutex stats_mutex_;
    StreamingStats stats_;

    /**
     * @brief Background streaming thread function
     */
    void streamingThreadFunction();

    /**
     * @brief Send batch of data points to Elodin DB
     */
    bool sendBatch(const std::vector<ElodinDataPoint>& batch);

    /**
     * @brief Convert data point to JSON format
     */
    std::string dataPointToJSON(const ElodinDataPoint& point) const;

    /**
     * @brief Convert convergence data to JSON format
     */
    std::string convergenceDataToJSON(const CalibrationConvergenceData& data) const;

    /**
     * @brief Create HTTP POST request to Elodin DB
     */
    bool sendHTTPRequest(const std::string& endpoint, const std::string& json_data);

    /**
     * @brief Update streaming statistics
     */
    void updateStats(bool success, double latency_ms);
};

/**
 * @brief Real-time calibration monitor with Elodin integration
 */
class RealTimeCalibrationMonitor {
public:
    RealTimeCalibrationMonitor(std::shared_ptr<ElodinDBInterface> elodin_interface);
    ~RealTimeCalibrationMonitor();

    /**
     * @brief Process PT measurement and stream to Elodin
     */
    void processPTMeasurement(const void* pt_message,  // PTMessage
                              double reference_pressure = 0.0);

    /**
     * @brief Process calibration update
     */
    void processCalibrationUpdate(const std::string& sensor_id, const CalibrationParameters& params,
                                  int iteration);

    /**
     * @brief Process human feedback
     */
    void processHumanFeedback(const std::string& sensor_id, double reference_pressure,
                              double measured_voltage, bool accepted);

    /**
     * @brief Get current calibration confidence for a sensor
     */
    double getCalibrationConfidence(const std::string& sensor_id) const;

    /**
     * @brief Get variance trend for a sensor
     */
    std::vector<double> getVarianceTrend(const std::string& sensor_id, int num_points = 50) const;

    /**
     * @brief Create all real-time plots for a sensor
     */
    void createAllPlots(const std::string& sensor_id);

private:
    std::shared_ptr<ElodinDBInterface> elodin_interface_;

    // Per-sensor tracking
    struct SensorTracking {
        std::vector<CalibrationConvergenceData> convergence_history;
        std::vector<double> variance_history;
        std::vector<double> confidence_history;
        double current_confidence;
        int total_calibrations;
        std::chrono::system_clock::time_point last_update;
    };

    mutable std::mutex tracking_mutex_;
    std::map<std::string, SensorTracking> sensor_tracking_;

    /**
     * @brief Update sensor tracking data
     */
    void updateSensorTracking(const std::string& sensor_id, const CalibrationParameters& params,
                              int iteration);

    /**
     * @brief Calculate confidence score from parameters
     */
    double calculateConfidenceScore(const CalibrationParameters& params) const;
};

#endif  // ELODIN_DB_INTERFACE_HPP
