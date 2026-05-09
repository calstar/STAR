#ifndef FSW_CONTROL_CONTROLLER_LUT_HPP
#define FSW_CONTROL_CONTROLLER_LUT_HPP

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace fsw {
namespace control {

/**
 * @brief Controller LUT loader with multilinear interpolation.
 *
 * Loads binary LUT exported by scripts/controller_lut/export_lut_for_fsw.py.
 * Used to bypass DDP and output optimal control (u_safe_F, u_safe_O or duty_F, duty_O)
 * for boolean solenoid actuation.
 */
class ControllerLUT {
public:
    ControllerLUT() = default;

    /** Load LUT from binary file. Returns false on error. */
    bool load(const std::string& path);

    /** True if a LUT is loaded and ready for evaluation. */
    bool is_loaded() const {
        return !axes_.empty();
    }

    /**
     * Evaluate LUT at the given point.
     * @param point  Map from axis name -> value (e.g. P_u_fuel, P_u_ox, thrust_desired)
     * @param out    Map from output name -> interpolated value (e.g. u_safe_F, u_safe_O, duty_F,
     * duty_O)
     * @return true if evaluation succeeded
     */
    bool evaluate(const std::map<std::string, double>& point,
                  std::map<std::string, double>& out) const;

private:
    struct Axis {
        std::string name;
        std::vector<double> grid;
    };
    struct Output {
        std::string name;
        std::vector<double> data;
        std::vector<uint32_t> shape;
    };

    std::vector<Axis> axes_;
    std::vector<Output> outputs_;
};

}  // namespace control
}  // namespace fsw

#endif  // FSW_CONTROL_CONTROLLER_LUT_HPP
