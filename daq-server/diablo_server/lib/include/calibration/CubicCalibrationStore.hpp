#ifndef CUBIC_CALIBRATION_STORE_HPP
#define CUBIC_CALIBRATION_STORE_HPP

#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace fsw {
namespace calibration {

/** One operator-captured calibration point: raw ADC code paired with a known reference PSI. */
struct CubicPoint {
    double adc = 0.0;
    double psi = 0.0;
    double t = 0.0;  // capture time (unix seconds), display/audit only
};

/**
 * Result of a least-squares polynomial fit over a channel's captured points.
 * Two equivalent representations are kept:
 *   - raw cubic  psi = A*adc^3 + B*adc^2 + C*adc + D   (consumed by PTCalibrationCoeffs, raw int32)
 *   - normalized psi = sum poly[i] * ((adc - norm_min)/norm_scale)^i  (well-conditioned; TS side)
 * The normalized form is what the frontend evaluates and what passes the backend's coefficient
 * validator (which rejects |A| > 1e-11 on a raw-ADC cubic).
 */
struct CubicFit {
    bool valid = false;
    double A = 0.0, B = 0.0, C = 0.0, D = 0.0;
    std::vector<double> poly;  // normalized coeffs, length = degree + 1
    double norm_min = 0.0;
    double norm_scale = 1.0;
    double rmse = 0.0;
    int degree = 0;
};

/** Per-sensor calibration record: identity, captured points, and the current fit. */
struct CubicChannel {
    uint16_t uid = 0;       // board_id*100 + connector (UI key)
    uint8_t board_id = 0;   // uid / 100
    uint8_t connector = 0;  // uid % 100 (1..10)
    uint8_t logical_ch =
        0;             // pt_logical_calibration_channel(slot, connector) — PTCalibrationManager key
    std::string role;  // human role from config, e.g. "Fuel Upstream"
    std::vector<CubicPoint> points;
    CubicFit fit;
    std::string status = "PENDING";  // PENDING (<2 pts) | OK | ERROR
    std::string last_error;
    double updated_at = 0.0;
};

/**
 * Owns the per-channel captured points and the fitted cubic for the calibration service.
 * Thread-safe. Persists atomically to a single JSON file that is:
 *   - re-loadable by this class on restart (resume points, re-fit), and
 *   - backward-compatible with the existing calibration_polynomials/poly_coeffs loaders
 *     (logical-channel-keyed) so the file doubles as the factory-cubic overlay the service loads.
 * The service is the sole writer; the Node backend only reads the file to serve the UI.
 */
class CubicCalibrationStore {
public:
    explicit CubicCalibrationStore(std::string file_path);

    /** Attach/refresh identity + role for a uid (idempotent; call at startup and on each capture).
     */
    void register_channel(uint16_t uid, uint8_t board_id, uint8_t connector, uint8_t logical_ch,
                          const std::string& role);

    /** Append a capture point (raw ADC, reference PSI), cap history, and re-fit. Returns the fit.
     */
    CubicFit add_point(uint16_t uid, double adc, double psi);

    /** Drop all points + fit for a uid (channel goes back to PENDING). */
    void clear_channel(uint16_t uid);

    const CubicFit* fit_for(uint16_t uid) const;
    const CubicChannel* channel(uint16_t uid) const;
    std::vector<uint16_t> uids() const;

    /** Atomically write the JSON record (temp + rename). */
    bool save() const;

    /** Load the JSON record, resume points, and re-fit each channel. Returns channels loaded. */
    size_t load();

    static constexpr size_t kMaxPoints = 20;

private:
    mutable std::mutex mutex_;
    std::string file_path_;
    std::map<uint16_t, CubicChannel> channels_;

    CubicFit compute_fit(const std::vector<CubicPoint>& pts) const;
    std::string serialize() const;  // caller holds mutex_
};

}  // namespace calibration
}  // namespace fsw

#endif  // CUBIC_CALIBRATION_STORE_HPP
