#include "PTCalibrationTool.hpp"

#include <chrono>
#include <fstream>
#include <iostream>
#include <random>
#include <sstream>

// Simple StandardCalibrationMap implementation
class StandardCalibrationMap : public CalibrationMapFunction {
public:
    StandardCalibrationMap() {
    }

    virtual double evaluate(double voltage, const EnvironmentalState& env_state,
                            const Eigen::VectorXd& theta) const override {
        // Simple linear calibration: pressure = theta[0] * voltage + theta[1]
        return theta(0) * voltage + theta(1);
    }

    virtual Eigen::VectorXd jacobian(double voltage, const EnvironmentalState& env_state,
                                     const Eigen::VectorXd& theta) const override {
        Eigen::VectorXd jacobian_vec(3);
        jacobian_vec(0) = voltage;  // d/dtheta[0]
        jacobian_vec(1) = 1.0;      // d/dtheta[1]
        jacobian_vec(2) = 0.0;      // d/dtheta[2] (no environmental dependence)
        return jacobian_vec;
    }

    virtual Eigen::VectorXd environmentalJacobian(double voltage,
                                                  const EnvironmentalState& env_state,
                                                  const Eigen::VectorXd& theta) const override {
        Eigen::VectorXd env_jacobian(5);  // 5 environmental parameters
        env_jacobian.setZero();           // No environmental dependence for standard map
        return env_jacobian;
    }

    virtual int getNumParameters() const override {
        return 3;
    }

    virtual std::vector<std::string> getParameterNames() const override {
        return {"slope", "offset", "env_factor"};
    }

    virtual bool validateParameters(const Eigen::VectorXd& theta) const override {
        return theta.size() == 3;
    }

    virtual std::string getDescription() const {
        return "Standard linear calibration map";
    }
};

// PTCalibrationTool Implementation
PTCalibrationTool::PTCalibrationTool(const std::string& calibration_map_type)
    : calibration_map_(nullptr) {
    // Initialize calibration map based on type
    if (calibration_map_type == "environmental_robust") {
        calibration_map_ = std::make_shared<EnvironmentalRobustCalibrationMap>();
    } else {
        // Default to standard calibration map - create a simple one
        calibration_map_ = std::make_shared<StandardCalibrationMap>();
    }
}

PTCalibrationTool::~PTCalibrationTool() {
    // Destructor implementation
}

CalibrationProcedure PTCalibrationTool::createCalibrationProcedure(const std::string& name,
                                                                   double pressure_range_min,
                                                                   double pressure_range_max,
                                                                   int num_points,
                                                                   bool include_env_variations) {
    CalibrationProcedure procedure;
    procedure.name = name;
    procedure.include_environmental_variations = include_env_variations;

    // Generate pressure points
    for (int i = 0; i < num_points; ++i) {
        double pressure =
            pressure_range_min + (pressure_range_max - pressure_range_min) * i / (num_points - 1);
        procedure.pressure_points.push_back(pressure);
        procedure.dwell_times.push_back(30.0);  // Default 30 second dwell
    }

    return procedure;
}

std::string PTCalibrationTool::startCalibrationSession(uint8_t sensor_id, uint8_t pt_location,
                                                       const CalibrationProcedure& procedure) {
    std::string session_id = generateSessionID();

    auto session = std::make_shared<CalibrationSession>();
    session->session_id = session_id;
    session->sensor_id = std::to_string(sensor_id);
    session->pt_location_enum = pt_location;
    session->start_time = std::chrono::system_clock::now();
    session->calibration_successful = false;

    active_sessions_[session_id] = session;

    return session_id;
}

bool PTCalibrationTool::addCalibrationDataPoint(const std::string& session_id, double voltage,
                                                double reference_pressure,
                                                const EnvironmentalState& environment) {
    auto it = active_sessions_.find(session_id);
    if (it == active_sessions_.end()) {
        return false;
    }

    CalibrationDataPoint data_point;
    data_point.reference_pressure = reference_pressure;
    data_point.voltage = voltage;
    data_point.reference_pressure_uncertainty = 50.0;  // Default uncertainty
    data_point.environment = environment;
    data_point.timestamp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                  std::chrono::system_clock::now().time_since_epoch())
                                  .count();

    it->second->data_points.push_back(data_point);

    return true;
}

CalibrationSession PTCalibrationTool::completeCalibrationSession(
    const std::string& session_id, const Eigen::VectorXd* population_prior_mean,
    const Eigen::MatrixXd* population_prior_covariance) {
    auto it = active_sessions_.find(session_id);
    if (it == active_sessions_.end()) {
        return CalibrationSession();  // Return empty session
    }

    auto session = it->second;
    session->end_time = std::chrono::system_clock::now();

    // Perform calibration using the framework
    PTCalibrationFramework framework(calibration_map_);
    framework.addCalibrationData(session->data_points);

    // Use default priors if not provided
    Eigen::VectorXd prior_mean;
    Eigen::MatrixXd prior_cov;
    if (population_prior_mean && population_prior_covariance) {
        prior_mean = *population_prior_mean;
        prior_cov = *population_prior_covariance;
    } else {
        auto priors = computePopulationPriors();
        prior_mean = priors.first;
        prior_cov = priors.second;
    }

    CalibrationParameters result = framework.performBayesianCalibration(prior_mean, prior_cov);
    session->calibration_result = result;
    session->calibration_successful = true;

    // Move to completed sessions (remove from active)
    active_sessions_.erase(it);

    return *session;
}

CalibrationSession PTCalibrationTool::loadCalibrationSession(const std::string& filename) {
    CalibrationSession session;

    std::ifstream file(filename);
    if (!file.is_open()) {
        return session;  // Return empty session
    }

    // Basic CSV loading implementation
    std::string line;
    std::getline(file, line);  // Skip header

    while (std::getline(file, line)) {
        std::istringstream iss(line);
        std::string token;
        std::vector<std::string> tokens;

        while (std::getline(iss, token, ',')) {
            tokens.push_back(token);
        }

        if (tokens.size() >= 4) {
            CalibrationDataPoint data_point;
            data_point.reference_pressure = std::stod(tokens[0]);
            data_point.voltage = std::stod(tokens[1]);
            data_point.reference_pressure_uncertainty = 50.0;  // Default uncertainty
            data_point.timestamp_ns = std::stoull(tokens[3]);

            session.data_points.push_back(data_point);
        }
    }

    file.close();
    return session;
}

bool PTCalibrationTool::saveCalibrationSession(const CalibrationSession& session,
                                               const std::string& filename) {
    std::ofstream file(filename);
    if (!file.is_open()) {
        return false;
    }

    file << "reference_pressure,voltage,uncertainty,timestamp_ns" << std::endl;
    for (const auto& point : session.data_points) {
        file << point.reference_pressure << "," << point.voltage << ","
             << point.reference_pressure_uncertainty << "," << point.timestamp_ns << std::endl;
    }

    file.close();
    return true;
}

std::pair<bool, std::string> PTCalibrationTool::validateCalibrationSession(
    const CalibrationSession& session) {
    std::string error_msg;

    if (session.data_points.empty()) {
        error_msg = "No calibration data points";
        return {false, error_msg};
    }

    if (session.data_points.size() < 5) {
        error_msg = "Insufficient data points for calibration";
        return {false, error_msg};
    }

    return {true, ""};
}

std::string PTCalibrationTool::generateCalibrationReport(const CalibrationSession& session) {
    std::ostringstream report;

    report << "Calibration Report for Session: " << session.session_id << std::endl;
    report << "Sensor ID: " << session.sensor_id << std::endl;
    report << "PT Location: " << static_cast<int>(session.pt_location_enum) << std::endl;
    report << "Data Points: " << session.data_points.size() << std::endl;
    report << "Calibration Successful: " << (session.calibration_successful ? "Yes" : "No")
           << std::endl;

    if (session.calibration_successful) {
        report << "Calibration Parameters:" << std::endl;
        for (int i = 0; i < static_cast<int>(session.calibration_result.theta.size()); ++i) {
            report << "  theta[" << i << "] = " << session.calibration_result.theta(i) << std::endl;
        }
    }

    return report.str();
}

std::vector<std::string> PTCalibrationTool::getActiveSessions() const {
    std::vector<std::string> ids;
    for (const auto& pair : active_sessions_) {
        ids.push_back(pair.first);
    }
    return ids;
}

std::shared_ptr<CalibrationSession> PTCalibrationTool::getCalibrationSession(
    const std::string& session_id) const {
    auto it = active_sessions_.find(session_id);
    if (it != active_sessions_.end()) {
        return it->second;
    }
    return nullptr;
}

bool PTCalibrationTool::cancelCalibrationSession(const std::string& session_id) {
    auto it = active_sessions_.find(session_id);
    if (it != active_sessions_.end()) {
        active_sessions_.erase(it);
        return true;
    }
    return false;
}

std::string PTCalibrationTool::generateSessionID() {
    auto now = std::chrono::system_clock::now();
    auto timestamp =
        std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
    return "session_" + std::to_string(timestamp);
}

std::pair<bool, std::string> PTCalibrationTool::validateCalibrationData(
    const CalibrationSession& session) {
    return validateCalibrationSession(session);
}

std::pair<Eigen::VectorXd, Eigen::MatrixXd> PTCalibrationTool::computePopulationPriors() {
    // Default population priors
    Eigen::VectorXd prior_mean = Eigen::VectorXd::Zero(3);
    prior_mean(0) = 1000.0;
    prior_mean(1) = 1000.0;
    prior_mean(2) = 0.0;

    Eigen::MatrixXd prior_cov = Eigen::MatrixXd::Identity(3, 3) * 100.0;

    return {prior_mean, prior_cov};
}

// PTCalibrationDataCollector Implementation
PTCalibrationDataCollector::PTCalibrationDataCollector(PTCalibrationTool& calibration_tool)
    : calibration_tool_(calibration_tool) {
}

PTCalibrationDataCollector::~PTCalibrationDataCollector() {
}

void PTCalibrationDataCollector::startDataCollection(const std::string& session_id,
                                                     double target_pressure, double dwell_time) {
    CollectionData data;
    data.session_id = session_id;
    data.target_pressure = target_pressure;
    data.dwell_time = dwell_time;
    data.start_time = std::chrono::system_clock::now();
    data.is_active = true;

    collections_[session_id] = data;
}

void PTCalibrationDataCollector::stopDataCollection(const std::string& session_id) {
    auto it = collections_.find(session_id);
    if (it != collections_.end()) {
        it->second.is_active = false;
        it->second.end_time = std::chrono::system_clock::now();
    }
}

void PTCalibrationDataCollector::addPTMeasurement(const PTMessage& pt_message,
                                                  double reference_pressure,
                                                  const EnvironmentalState& environment) {
    // Find the appropriate session
    uint8_t sensor_id = pt_message.getField<1>();
    std::string session_key = "sensor_" + std::to_string(sensor_id);

    auto it = collections_.find(session_key);
    if (it != collections_.end()) {
        it->second.measurements.push_back(pt_message);
    }
}

std::string PTCalibrationDataCollector::getCollectionStatus(const std::string& session_id) const {
    auto it = collections_.find(session_id);
    if (it == collections_.end()) {
        return "Session not found";
    }

    if (!it->second.is_active) {
        return "Complete";
    }

    auto now = std::chrono::system_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - it->second.start_time);

    if (elapsed.count() >= it->second.dwell_time) {
        return "Ready to stop";
    }

    return "Collecting (" + std::to_string(elapsed.count()) + "s / " +
           std::to_string(it->second.dwell_time) + "s)";
}

bool PTCalibrationDataCollector::isCollectionComplete(const std::string& session_id) const {
    auto it = collections_.find(session_id);
    if (it == collections_.end()) {
        return false;
    }

    return !it->second.is_active;
}
