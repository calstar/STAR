#include "control/ControllerLUT.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>

namespace fsw {
namespace control {

namespace {
constexpr uint8_t MAGIC[] = {'L', 'U', 'T', 'C'};
constexpr uint8_t VERSION = 1;
constexpr size_t MAX_AXES = 8;
constexpr size_t MAX_OUTPUTS = 32;
constexpr size_t MAX_NAME_LEN = 255;
}  // namespace

bool ControllerLUT::load(const std::string& path) {
    axes_.clear();
    outputs_.clear();

    std::ifstream f(path, std::ios::binary);
    if (!f) {
        std::cerr << "[ControllerLUT] Failed to open: " << path << std::endl;
        return false;
    }

    uint8_t magic[4];
    if (!f.read(reinterpret_cast<char*>(magic), 4) || std::memcmp(magic, MAGIC, 4) != 0) {
        std::cerr << "[ControllerLUT] Invalid magic in " << path << std::endl;
        return false;
    }

    uint8_t version, num_axes, num_outputs, reserved;
    if (!f.read(reinterpret_cast<char*>(&version), 1) || version != VERSION) {
        std::cerr << "[ControllerLUT] Unsupported version " << (int)version << std::endl;
        return false;
    }
    if (!f.read(reinterpret_cast<char*>(&num_axes), 1) || num_axes > MAX_AXES) {
        std::cerr << "[ControllerLUT] Invalid num_axes " << (int)num_axes << std::endl;
        return false;
    }
    if (!f.read(reinterpret_cast<char*>(&num_outputs), 1) || num_outputs > MAX_OUTPUTS) {
        std::cerr << "[ControllerLUT] Invalid num_outputs " << (int)num_outputs << std::endl;
        return false;
    }
    if (!f.read(reinterpret_cast<char*>(&reserved), 1))
        return false;

    for (uint8_t a = 0; a < num_axes; ++a) {
        Axis ax;
        uint8_t name_len;
        if (!f.read(reinterpret_cast<char*>(&name_len), 1))
            return false;
        ax.name.resize(std::min(static_cast<size_t>(name_len), MAX_NAME_LEN));
        if (!f.read(&ax.name[0], ax.name.size()))
            return false;
        if (name_len > MAX_NAME_LEN)
            f.ignore(name_len - MAX_NAME_LEN);

        uint32_t grid_len;
        if (!f.read(reinterpret_cast<char*>(&grid_len), 4))
            return false;
        ax.grid.resize(grid_len);
        if (!f.read(reinterpret_cast<char*>(ax.grid.data()), grid_len * sizeof(double)))
            return false;

        axes_.push_back(std::move(ax));
    }

    for (uint8_t o = 0; o < num_outputs; ++o) {
        Output out;
        uint8_t name_len;
        if (!f.read(reinterpret_cast<char*>(&name_len), 1))
            return false;
        out.name.resize(std::min(static_cast<size_t>(name_len), MAX_NAME_LEN));
        if (!f.read(&out.name[0], out.name.size()))
            return false;
        if (name_len > MAX_NAME_LEN)
            f.ignore(name_len - MAX_NAME_LEN);

        out.shape.resize(axes_.size());
        if (!f.read(reinterpret_cast<char*>(out.shape.data()), axes_.size() * sizeof(uint32_t)))
            return false;

        size_t total = 1;
        for (uint32_t s : out.shape)
            total *= s;
        out.data.resize(total);
        if (!f.read(reinterpret_cast<char*>(out.data.data()), total * sizeof(double)))
            return false;

        outputs_.push_back(std::move(out));
    }

    std::cout << "[ControllerLUT] Loaded " << path << " (" << axes_.size() << " axes, "
              << outputs_.size() << " outputs)" << std::endl;
    return true;
}

bool ControllerLUT::evaluate(const std::map<std::string, double>& point,
                             std::map<std::string, double>& out) const {
    out.clear();
    if (axes_.empty() || outputs_.empty())
        return false;

    const size_t n_axes = axes_.size();
    if (n_axes > 20)
        return false;

    struct AxisInfo {
        size_t lo, hi;
        double w0, w1;
    };
    std::vector<AxisInfo> infos;
    infos.reserve(n_axes);

    for (const auto& ax : axes_) {
        auto it = point.find(ax.name);
        if (it == point.end()) {
            std::cerr << "[ControllerLUT] Missing axis '" << ax.name << "' in point" << std::endl;
            return false;
        }
        double x = it->second;
        const auto& grid = ax.grid;
        if (grid.empty())
            return false;

        size_t hi = std::lower_bound(grid.begin(), grid.end(), x) - grid.begin();
        if (hi <= 0)
            hi = 1;
        if (hi >= grid.size())
            hi = grid.size() - 1;
        size_t lo = hi - 1;

        double x0 = grid[lo];
        double x1 = grid[hi];
        double t = (x1 == x0) ? 0.0 : (x - x0) / (x1 - x0);
        t = std::clamp(t, 0.0, 1.0);
        infos.push_back({lo, hi, 1.0 - t, t});
    }

    for (const auto& output : outputs_) {
        std::vector<size_t> strides(n_axes);
        strides[n_axes - 1] = 1;
        for (int i = static_cast<int>(n_axes) - 2; i >= 0; --i)
            strides[i] = strides[i + 1] * output.shape[i + 1];

        double result = 0.0;
        const size_t n_corners = 1ULL << n_axes;
        for (size_t corner = 0; corner < n_corners; ++corner) {
            double w = 1.0;
            size_t flat_idx = 0;
            for (size_t i = 0; i < n_axes; ++i) {
                size_t idx = (corner >> i) & 1 ? infos[i].hi : infos[i].lo;
                double wi = (corner >> i) & 1 ? infos[i].w1 : infos[i].w0;
                w *= wi;
                flat_idx += idx * strides[i];
            }
            if (w >= 1e-10 && flat_idx < output.data.size()) {
                double v = output.data[flat_idx];
                if (std::isfinite(v))
                    result += w * v;
            }
        }
        out[output.name] = result;
    }
    return true;
}

}  // namespace control
}  // namespace fsw
