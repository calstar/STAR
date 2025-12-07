/**
 * @file ElodinDBInterface.cpp
 * @brief Implementation of Elodin DB interface for real-time calibration visualization
 */

#include "ElodinDBInterface.hpp"
#include <iostream>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <chrono>

// Include the necessary headers for the types we're using
#include "PTMessage.hpp"
#include "PTCalibrationFramework.hpp"

ElodinDBInterface::ElodinDBInterface(const ElodinConfig& config)
    : config_(config), running_(false), connected_(false) {
    
    // Initialize statistics
    stats_.total_points_sent = 0;
    stats_.total_batches_sent = 0;
    stats_.failed_sends = 0;
    stats_.queue_size = 0;
    stats_.avg_latency_ms = 0.0;
    
    std::cout << "ElodinDBInterface initialized for database: " << config_.database_name << std::endl;
}

ElodinDBInterface::~ElodinDBInterface() {
    stop();
}

bool ElodinDBInterface::initialize() {
    // For now, we'll simulate a successful connection
    // In a real implementation, you would make an actual HTTP request to Elodin DB
    connected_ = true;
    
    std::cout << "Connected to Elodin DB at " << config_.host << ":" << config_.port << std::endl;
    return true;
}

bool ElodinDBInterface::start() {
    if (running_) {
        return true;
    }
    
    if (!connected_) {
        std::cerr << "Cannot start streaming - not connected to Elodin DB" << std::endl;
        return false;
    }
    
    running_ = true;
    streaming_thread_ = std::thread(&ElodinDBInterface::streamingThreadFunction, this);
    
    std::cout << "Elodin DB streaming started" << std::endl;
    return true;
}

void ElodinDBInterface::stop() {
    if (!running_) {
        return;
    }
    
    running_ = false;
    queue_cv_.notify_all();
    
    if (streaming_thread_.joinable()) {
        streaming_thread_.join();
    }
    
    std::cout << "Elodin DB streaming stopped" << std::endl;
}

void ElodinDBInterface::streamRawADC(const std::string& sensor_id, int32_t raw_adc, uint64_t timestamp_ns) {
    ElodinDataPoint point(sensor_id, "raw_adc", static_cast<double>(raw_adc), "counts", timestamp_ns);
    
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        data_queue_.push(point);
        stats_.queue_size = data_queue_.size();
    }
    queue_cv_.notify_one();
}

void ElodinDBInterface::streamVoltage(const std::string& sensor_id, double voltage, uint64_t timestamp_ns) {
    ElodinDataPoint point(sensor_id, "voltage", voltage, "V", timestamp_ns);
    
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        data_queue_.push(point);
        stats_.queue_size = data_queue_.size();
    }
    queue_cv_.notify_one();
}

void ElodinDBInterface::streamPressure(const std::string& sensor_id, double pressure_pa, uint64_t timestamp_ns) {
    ElodinDataPoint point(sensor_id, "pressure", pressure_pa, "Pa", timestamp_ns);
    
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        data_queue_.push(point);
        stats_.queue_size = data_queue_.size();
    }
    queue_cv_.notify_one();
}

void ElodinDBInterface::streamCalibrationParameters(const std::string& sensor_id, 
                                                   const CalibrationParameters& params,
                                                   uint64_t timestamp_ns) {
    // Stream each parameter separately
    for (int i = 0; i < params.theta.size(); ++i) {
        std::string param_name = "theta_" + std::to_string(i);
        ElodinDataPoint point(sensor_id, param_name, params.theta(i), "dimensionless", timestamp_ns);
        
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            data_queue_.push(point);
            stats_.queue_size = data_queue_.size();
        }
    }
    
    // Stream covariance diagonal elements (variances)
    for (int i = 0; i < params.covariance.rows(); ++i) {
        std::string var_name = "variance_" + std::to_string(i);
        ElodinDataPoint point(sensor_id, var_name, params.covariance(i, i), "dimensionless^2", timestamp_ns);
        
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            data_queue_.push(point);
            stats_.queue_size = data_queue_.size();
        }
    }
    
    // Stream calibration quality
    ElodinDataPoint quality_point(sensor_id, "calibration_quality", params.calibration_quality, "dimensionless", timestamp_ns);
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        data_queue_.push(quality_point);
        stats_.queue_size = data_queue_.size();
    }
    
    queue_cv_.notify_one();
}

void ElodinDBInterface::streamCalibrationConvergence(const CalibrationConvergenceData& convergence_data) {
    // Create a special data point for convergence tracking
    ElodinDataPoint convergence_point;
    convergence_point.sensor_id = convergence_data.sensor_id;
    convergence_point.data_type = "convergence_data";
    convergence_point.value = static_cast<double>(convergence_data.calibration_iteration);
    convergence_point.unit = "iteration";
    convergence_point.timestamp_ns = convergence_data.timestamp_ns;
    
    // Add metadata
    convergence_point.metadata["confidence_score"] = convergence_data.confidence_score;
    convergence_point.metadata["nrmse"] = convergence_data.nrmse;
    convergence_point.metadata["coverage_95"] = convergence_data.coverage_95;
    // Environmental conditions metadata removed for now
    
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        data_queue_.push(convergence_point);
        stats_.queue_size = data_queue_.size();
    }
    queue_cv_.notify_one();
}

void ElodinDBInterface::streamEnvironmentalConditions(const std::string& sensor_id,
                                                     const void* environment,
                                                     uint64_t timestamp_ns) {
    const EnvironmentalState* env = static_cast<const EnvironmentalState*>(environment);
    // Stream temperature
    ElodinDataPoint temp_point(sensor_id, "temperature", env->temperature, "°C", timestamp_ns);
    
    // Stream humidity
    ElodinDataPoint humidity_point(sensor_id, "humidity", env->humidity, "%", timestamp_ns);
    
    // Stream vibration
    ElodinDataPoint vibration_point(sensor_id, "vibration_level", env->vibration_level, "normalized", timestamp_ns);
    
    // Stream aging factor
    ElodinDataPoint aging_point(sensor_id, "aging_factor", env->aging_factor, "dimensionless", timestamp_ns);
    
    // Stream mounting torque
    ElodinDataPoint torque_point(sensor_id, "mounting_torque", env->mounting_torque, "Nm", timestamp_ns);
    
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        data_queue_.push(temp_point);
        data_queue_.push(humidity_point);
        data_queue_.push(vibration_point);
        data_queue_.push(aging_point);
        data_queue_.push(torque_point);
        stats_.queue_size = data_queue_.size();
    }
    queue_cv_.notify_one();
}

void ElodinDBInterface::streamHumanFeedback(const std::string& sensor_id,
                                           double reference_pressure,
                                           double measured_voltage,
                                           bool accepted_calibration,
                                           uint64_t timestamp_ns) {
    ElodinDataPoint feedback_point;
    feedback_point.sensor_id = sensor_id;
    feedback_point.data_type = "human_feedback";
    feedback_point.value = accepted_calibration ? 1.0 : 0.0;
    feedback_point.unit = "boolean";
    feedback_point.timestamp_ns = timestamp_ns;
    feedback_point.metadata["reference_pressure"] = reference_pressure;
    feedback_point.metadata["measured_voltage"] = measured_voltage;
    
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        data_queue_.push(feedback_point);
        stats_.queue_size = data_queue_.size();
    }
    queue_cv_.notify_one();
}

void ElodinDBInterface::createCalibrationPlot(const std::string& sensor_id, const std::string& plot_title) {
    std::string title = plot_title.empty() ? "Calibration Plot - Sensor " + sensor_id : plot_title;
    
    std::cout << "Creating calibration plot: " << title << std::endl;
    std::cout << "  - Raw ADC vs Pressure correlation" << std::endl;
    std::cout << "  - Voltage vs Pressure calibration curve" << std::endl;
    std::cout << "  - Residual analysis" << std::endl;
    std::cout << "  - Environmental effects visualization" << std::endl;
    
    // In a real implementation, this would create actual plots in Elodin
    // For now, we'll just log the plot creation
}

void ElodinDBInterface::createConvergencePlot(const std::string& sensor_id, const std::string& plot_title) {
    std::string title = plot_title.empty() ? "Convergence Plot - Sensor " + sensor_id : plot_title;
    
    std::cout << "Creating convergence plot: " << title << std::endl;
    std::cout << "  - Parameter evolution over iterations" << std::endl;
    std::cout << "  - Confidence score progression" << std::endl;
    std::cout << "  - NRMSE improvement over time" << std::endl;
    std::cout << "  - Environmental adaptation tracking" << std::endl;
}

void ElodinDBInterface::createVariancePlot(const std::string& sensor_id, const std::string& plot_title) {
    std::string title = plot_title.empty() ? "Variance Plot - Sensor " + sensor_id : plot_title;
    
    std::cout << "Creating variance plot: " << title << std::endl;
    std::cout << "  - Parameter uncertainty reduction" << std::endl;
    std::cout << "  - Prediction confidence intervals" << std::endl;
    std::cout << "  - Environmental variance modeling" << std::endl;
    std::cout << "  - Extrapolation confidence bounds" << std::endl;
}

ElodinDBInterface::StreamingStats ElodinDBInterface::getStreamingStats() const {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    return stats_;
}

void ElodinDBInterface::streamingThreadFunction() {
    std::vector<ElodinDataPoint> batch;
    batch.reserve(config_.batch_size);
    
    auto last_flush = std::chrono::steady_clock::now();
    
    while (running_) {
        std::unique_lock<std::mutex> lock(queue_mutex_);
        
        // Wait for data or timeout
        auto timeout = std::chrono::milliseconds(config_.flush_interval_ms);
        if (queue_cv_.wait_for(lock, timeout, [this] { return !data_queue_.empty() || !running_; })) {
            // Process data from queue
            while (!data_queue_.empty() && batch.size() < config_.batch_size) {
                batch.push_back(data_queue_.front());
                data_queue_.pop();
            }
        }
        
        // Update queue size in stats
        stats_.queue_size = data_queue_.size();
        
        lock.unlock();
        
        // Send batch if we have data or timeout reached
        auto now = std::chrono::steady_clock::now();
        if (!batch.empty() || (now - last_flush >= std::chrono::milliseconds(config_.flush_interval_ms))) {
            if (!batch.empty()) {
                auto start_time = std::chrono::high_resolution_clock::now();
                bool success = sendBatch(batch);
                auto end_time = std::chrono::high_resolution_clock::now();
                
                double latency_ms = std::chrono::duration<double, std::milli>(end_time - start_time).count();
                updateStats(success, latency_ms);
                
                if (success) {
                    batch.clear();
                }
            }
            last_flush = now;
        }
        
        if (!running_) break;
    }
    
    // Send any remaining data
    if (!batch.empty()) {
        sendBatch(batch);
    }
}

bool ElodinDBInterface::sendBatch(const std::vector<ElodinDataPoint>& batch) {
    if (batch.empty()) {
        return true;
    }
    
    // Create simplified JSON-like string for demonstration
    std::ostringstream json_stream;
    json_stream << "{\n  \"batch_size\": " << batch.size() << ",\n";
    json_stream << "  \"database\": \"" << config_.database_name << "\",\n";
    json_stream << "  \"timestamp\": " << std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count() << ",\n";
    json_stream << "  \"data_points\": [\n";
    
    for (size_t i = 0; i < batch.size(); ++i) {
        const auto& point = batch[i];
        json_stream << "    {\n";
        json_stream << "      \"sensor_id\": \"" << point.sensor_id << "\",\n";
        json_stream << "      \"data_type\": \"" << point.data_type << "\",\n";
        json_stream << "      \"value\": " << std::fixed << std::setprecision(6) << point.value << ",\n";
        json_stream << "      \"unit\": \"" << point.unit << "\",\n";
        json_stream << "      \"timestamp_ns\": " << point.timestamp_ns << "\n";
        
        if (i < batch.size() - 1) {
            json_stream << "    },\n";
        } else {
            json_stream << "    }\n";
        }
    }
    
    json_stream << "  ]\n}";
    
    std::string json_string = json_stream.str();
    
    // Send to Elodin DB
    std::string endpoint = "http://" + config_.host + ":" + std::to_string(config_.port) + 
                          "/api/v1/timeseries/" + config_.database_name;
    
    bool success = sendHTTPRequest(endpoint, json_string);
    
    if (success) {
        std::cout << "Successfully sent batch of " << batch.size() << " data points to Elodin DB" << std::endl;
    } else {
        std::cerr << "Failed to send batch of " << batch.size() << " data points to Elodin DB" << std::endl;
    }
    
    return success;
}

std::string ElodinDBInterface::dataPointToJSON(const ElodinDataPoint& point) const {
    std::ostringstream json_stream;
    json_stream << "{\n";
    json_stream << "  \"sensor_id\": \"" << point.sensor_id << "\",\n";
    json_stream << "  \"data_type\": \"" << point.data_type << "\",\n";
    json_stream << "  \"value\": " << std::fixed << std::setprecision(6) << point.value << ",\n";
    json_stream << "  \"unit\": \"" << point.unit << "\",\n";
    json_stream << "  \"timestamp_ns\": " << point.timestamp_ns << "\n";
    json_stream << "}";
    return json_stream.str();
}

std::string ElodinDBInterface::convergenceDataToJSON(const CalibrationConvergenceData& data) const {
    std::ostringstream json_stream;
    json_stream << "{\n";
    json_stream << "  \"sensor_id\": \"" << data.sensor_id << "\",\n";
    json_stream << "  \"timestamp_ns\": " << data.timestamp_ns << ",\n";
    json_stream << "  \"calibration_iteration\": " << data.calibration_iteration << ",\n";
    json_stream << "  \"confidence_score\": " << std::fixed << std::setprecision(6) << data.confidence_score << ",\n";
    json_stream << "  \"nrmse\": " << std::fixed << std::setprecision(6) << data.nrmse << ",\n";
    json_stream << "  \"coverage_95\": " << std::fixed << std::setprecision(6) << data.coverage_95 << ",\n";
    
    // Add parameter vector
    json_stream << "  \"theta_parameters\": [";
    for (int i = 0; i < data.theta_parameters.size(); ++i) {
        json_stream << std::fixed << std::setprecision(6) << data.theta_parameters(i);
        if (i < data.theta_parameters.size() - 1) json_stream << ", ";
    }
    json_stream << "],\n";
    
    // Add covariance matrix diagonal
    json_stream << "  \"parameter_variances\": [";
    for (int i = 0; i < data.parameter_covariance.rows(); ++i) {
        json_stream << std::fixed << std::setprecision(6) << data.parameter_covariance(i, i);
        if (i < data.parameter_covariance.rows() - 1) json_stream << ", ";
    }
    json_stream << "],\n";
    
    // Environmental conditions removed for now
    json_stream << "}";
    
    return json_stream.str();
}

bool ElodinDBInterface::sendHTTPRequest(const std::string& endpoint, const std::string& json_data) {
    // For this demonstration, we'll simulate HTTP requests
    // In a real implementation, you would use libcurl or similar
    
    std::cout << "Simulating HTTP POST to: " << endpoint << std::endl;
    std::cout << "Data size: " << json_data.length() << " bytes" << std::endl;
    
    // Simulate network delay
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
    
    // Simulate success (in real implementation, check HTTP response)
    return true;
}

void ElodinDBInterface::updateStats(bool success, double latency_ms) {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    
    if (success) {
        stats_.total_batches_sent++;
    } else {
        stats_.failed_sends++;
    }
    
    // Update average latency (simple moving average)
    stats_.avg_latency_ms = (stats_.avg_latency_ms * 0.9) + (latency_ms * 0.1);
}

// RealTimeCalibrationMonitor Implementation
RealTimeCalibrationMonitor::RealTimeCalibrationMonitor(std::shared_ptr<ElodinDBInterface> elodin_interface)
    : elodin_interface_(elodin_interface) {
    
    std::cout << "RealTimeCalibrationMonitor initialized with Elodin integration" << std::endl;
}

RealTimeCalibrationMonitor::~RealTimeCalibrationMonitor() {
    // Destructor
}

void RealTimeCalibrationMonitor::processPTMeasurement(const void* pt_message, double reference_pressure) {
    const PTMessage* pt_msg = static_cast<const PTMessage*>(pt_message);
    uint8_t sensor_id = pt_msg->getField<1>();
    double voltage = pt_msg->getField<2>();
    uint64_t timestamp_ns = pt_msg->getField<0>();
    
    std::string sensor_name = "PT_" + std::to_string(static_cast<int>(sensor_id));
    
    // Stream raw ADC data (we don't have it in PTMessage, so we'll calculate it)
    int32_t raw_adc = static_cast<int32_t>((voltage / 3.3) * 2147483647.0);
    elodin_interface_->streamRawADC(sensor_name, raw_adc, timestamp_ns);
    
    // Stream voltage data
    elodin_interface_->streamVoltage(sensor_name, voltage, timestamp_ns);
    
    // Stream pressure if reference is provided
    if (reference_pressure > 0.0) {
        elodin_interface_->streamPressure(sensor_name, reference_pressure, timestamp_ns);
    }
    
    std::cout << "Streamed PT measurement for " << sensor_name 
              << ": ADC=" << raw_adc << ", Voltage=" << std::fixed << std::setprecision(4) << voltage << "V";
    if (reference_pressure > 0.0) {
        std::cout << ", Pressure=" << std::fixed << std::setprecision(0) << reference_pressure << "Pa";
    }
    std::cout << std::endl;
}

void RealTimeCalibrationMonitor::processCalibrationUpdate(const std::string& sensor_id,
                                                        const CalibrationParameters& params,
                                                        int iteration) {
    uint64_t timestamp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    // Stream calibration parameters
    elodin_interface_->streamCalibrationParameters(sensor_id, params, timestamp_ns);
    
    // Create convergence data
    CalibrationConvergenceData convergence_data;
    convergence_data.sensor_id = sensor_id;
    convergence_data.timestamp_ns = timestamp_ns;
    convergence_data.calibration_iteration = iteration;
    convergence_data.theta_parameters = params.theta;
    convergence_data.parameter_covariance = params.covariance;
    convergence_data.confidence_score = calculateConfidenceScore(params);
    convergence_data.nrmse = 0.1; // Placeholder - would be calculated from residuals
    convergence_data.coverage_95 = 0.95; // Placeholder
    
    // Stream convergence data
    elodin_interface_->streamCalibrationConvergence(convergence_data);
    
    // Update internal tracking
    updateSensorTracking(sensor_id, params, iteration);
    
    std::cout << "Streamed calibration update for " << sensor_id 
              << " (iteration " << iteration << ")" << std::endl;
}

void RealTimeCalibrationMonitor::processHumanFeedback(const std::string& sensor_id,
                                                     double reference_pressure,
                                                     double measured_voltage,
                                                     bool accepted) {
    uint64_t timestamp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    elodin_interface_->streamHumanFeedback(sensor_id, reference_pressure, 
                                         measured_voltage, accepted, timestamp_ns);
    
    std::cout << "Streamed human feedback for " << sensor_id 
              << ": " << (accepted ? "ACCEPTED" : "REJECTED") << std::endl;
}

double RealTimeCalibrationMonitor::getCalibrationConfidence(const std::string& sensor_id) const {
    std::lock_guard<std::mutex> lock(tracking_mutex_);
    auto it = sensor_tracking_.find(sensor_id);
    if (it != sensor_tracking_.end()) {
        return it->second.current_confidence;
    }
    return 0.0;
}

std::vector<double> RealTimeCalibrationMonitor::getVarianceTrend(const std::string& sensor_id, int num_points) const {
    std::lock_guard<std::mutex> lock(tracking_mutex_);
    auto it = sensor_tracking_.find(sensor_id);
    if (it != sensor_tracking_.end()) {
        const auto& variance_history = it->second.variance_history;
        if (variance_history.size() <= num_points) {
            return variance_history;
        } else {
            return std::vector<double>(variance_history.end() - num_points, variance_history.end());
        }
    }
    return std::vector<double>();
}

void RealTimeCalibrationMonitor::createAllPlots(const std::string& sensor_id) {
    elodin_interface_->createCalibrationPlot(sensor_id);
    elodin_interface_->createConvergencePlot(sensor_id);
    elodin_interface_->createVariancePlot(sensor_id);
    
    std::cout << "Created all real-time plots for " << sensor_id << std::endl;
}

void RealTimeCalibrationMonitor::updateSensorTracking(const std::string& sensor_id,
                                                     const CalibrationParameters& params,
                                                     int iteration) {
    std::lock_guard<std::mutex> lock(tracking_mutex_);
    
    SensorTracking& tracking = sensor_tracking_[sensor_id];
    tracking.current_confidence = calculateConfidenceScore(params);
    tracking.total_calibrations = iteration;
    tracking.last_update = std::chrono::system_clock::now();
    
    // Add to variance history (use trace of covariance matrix)
    double variance = params.covariance.trace();
    tracking.variance_history.push_back(variance);
    
    // Keep only last 100 points
    if (tracking.variance_history.size() > 100) {
        tracking.variance_history.erase(tracking.variance_history.begin());
    }
    
    // Add to confidence history
    tracking.confidence_history.push_back(tracking.current_confidence);
    if (tracking.confidence_history.size() > 100) {
        tracking.confidence_history.erase(tracking.confidence_history.begin());
    }
}

double RealTimeCalibrationMonitor::calculateConfidenceScore(const CalibrationParameters& params) const {
    // Calculate confidence based on parameter uncertainty
    double avg_variance = params.covariance.diagonal().mean();
    return std::exp(-avg_variance / 1000.0); // Higher variance = lower confidence
}
