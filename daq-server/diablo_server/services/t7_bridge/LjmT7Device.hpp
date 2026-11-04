#pragma once

#include "t7/T7Stream.hpp"

namespace fsw {
namespace t7 {

/** A T7 reached over Ethernet through LabJack's LJM library. One instance per device. */
class LjmT7Device : public T7Device {
public:
    LjmT7Device() = default;
    ~LjmT7Device() override;
    LjmT7Device(const LjmT7Device&) = delete;
    LjmT7Device& operator=(const LjmT7Device&) = delete;

    void open(const std::string& ip) override;
    int64_t serial_number() override;
    void write_names(const std::vector<std::string>& names,
                     const std::vector<double>& values) override;
    std::vector<double> read_names(const std::vector<std::string>& names) override;
    double stream_start(const std::vector<std::string>& scan_names, int scans_per_read,
                        double scan_rate_hz) override;
    Backlog stream_read(std::vector<double>& data) override;
    void stream_stop() override;
    void close() override;

private:
    int handle_ = -1;
    int num_addresses_ = 0;
    int scans_per_read_ = 0;
};

}  // namespace t7
}  // namespace fsw
