// T7Device over LabJack's LJM library (libLabJackM.so, LabJackM.h).
//
// Compiled only when CMake finds LJM (see CMakeLists.txt, T7_HAVE_LJM). LJM is closed source and
// installed separately on the DAQ host: https://labjack.com/support/software/installers/ljm

#include "LjmT7Device.hpp"

#include <LabJackM.h>

#include <iostream>
#include <vector>

namespace fsw {
namespace t7 {

namespace {

std::string ljm_message(int err) {
    char buf[LJM_MAX_NAME_SIZE] = {0};
    LJM_ErrorToString(err, buf);
    return std::string(buf) + " (" + std::to_string(err) + ")";
}

// LJM reserves 200-399 for warnings: the call did its job, with a caveat worth a log line.
bool is_warning(int err) {
    return err >= LJME_WARNINGS_BEGIN && err <= LJME_WARNINGS_END;
}

// A warning is still worth seeing: 203 LJME_USING_DEFAULT_CALIBRATION means LJM could not read
// the unit's own calibration and every volt is on nominal constants.
void warn(int err, const std::string& what) {
    std::cerr << ("t7_bridge: LJM warning from " + what + ": " + ljm_message(err) + "\n");
}

void check(int err, const std::string& what) {
    if (err == LJME_NOERROR)
        return;
    if (is_warning(err))
        return warn(err, what);
    throw T7Error(what + ": " + ljm_message(err), err);
}

// LJM library settings, once per process. LJM_AUTO_IPS (default on) caches discovered IPs in
// /usr/local/share/LabJack/LJM/ljm_auto_ips.json for "ANY" opens; we always open by explicit IP,
// and LabJack suggests turning it off in a sandboxed or read-only deployment ("What permissions
// does LJM need?"). Failing to set it is logged, not fatal.
void configure_library_once() {
    static const bool done = [] {
        const int err = LJM_WriteLibraryConfigS(LJM_AUTO_IPS, 0);
        if (err != LJME_NOERROR)
            warn(err, "LJM_WriteLibraryConfigS(LJM_AUTO_IPS, 0)");
        return true;
    }();
    (void)done;
}

}  // namespace

LjmT7Device::~LjmT7Device() {
    close();
}

void LjmT7Device::open(const std::string& ip) {
    close();
    configure_library_once();
    // Open by explicit IP over wired Ethernet only: "ANY" would happily open some other T7 on the
    // network (or one on USB), and "TCP" would also accept WiFi.
    check(LJM_OpenS("T7", "ETHERNET", ip.c_str(), &handle_), "LJM_OpenS(" + ip + ")");
}

int64_t LjmT7Device::serial_number() {
    double v = 0;
    check(LJM_eReadName(handle_, "SERIAL_NUMBER", &v), "read SERIAL_NUMBER");
    return static_cast<int64_t>(v);
}

void LjmT7Device::write_names(const std::vector<std::string>& names,
                              const std::vector<double>& values) {
    if (names.empty())
        return;
    std::vector<const char*> cnames;
    for (const auto& n : names)
        cnames.push_back(n.c_str());
    int error_address = -1;
    const int err = LJM_eWriteNames(handle_, static_cast<int>(cnames.size()), cnames.data(),
                                    values.data(), &error_address);
    if (is_warning(err))
        warn(err, "LJM_eWriteNames");
    if (err != LJME_NOERROR && !is_warning(err)) {
        // ErrorAddress is the Modbus address of the frame that failed; name it if we can.
        std::string which = "address " + std::to_string(error_address);
        std::vector<int> addrs(names.size()), types(names.size());
        if (LJM_NamesToAddresses(static_cast<int>(cnames.size()), cnames.data(), addrs.data(),
                                 types.data()) == LJME_NOERROR)
            for (size_t i = 0; i < names.size(); ++i)
                if (addrs[i] == error_address)
                    which = names[i];
        throw T7Error("writing " + which + ": " + ljm_message(err), err);
    }
}

std::vector<double> LjmT7Device::read_names(const std::vector<std::string>& names) {
    std::vector<const char*> cnames;
    for (const auto& n : names)
        cnames.push_back(n.c_str());
    std::vector<double> values(names.size(), 0.0);
    int error_address = -1;
    check(LJM_eReadNames(handle_, static_cast<int>(cnames.size()), cnames.data(), values.data(),
                         &error_address),
          "reading " + (names.empty() ? std::string() : names.front()) + "...");
    return values;
}

double LjmT7Device::stream_start(const std::vector<std::string>& scan_names, int scans_per_read,
                                 double scan_rate_hz) {
    std::vector<const char*> cnames;
    for (const auto& n : scan_names)
        cnames.push_back(n.c_str());
    std::vector<int> addrs(scan_names.size()), types(scan_names.size());
    check(LJM_NamesToAddresses(static_cast<int>(cnames.size()), cnames.data(), addrs.data(),
                               types.data()),
          "LJM_NamesToAddresses");
    double rate = scan_rate_hz;
    check(LJM_eStreamStart(handle_, scans_per_read, static_cast<int>(addrs.size()), addrs.data(),
                           &rate),
          "LJM_eStreamStart");
    num_addresses_ = static_cast<int>(addrs.size());
    scans_per_read_ = scans_per_read;
    return rate;
}

T7Device::Backlog LjmT7Device::stream_read(std::vector<double>& data) {
    data.resize(static_cast<size_t>(scans_per_read_) * num_addresses_);
    Backlog b;
    check(LJM_eStreamRead(handle_, data.data(), &b.device_scans, &b.ljm_scans), "LJM_eStreamRead");
    return b;
}

void LjmT7Device::stream_stop() {
    check(LJM_eStreamStop(handle_), "LJM_eStreamStop");
}

void LjmT7Device::close() {
    if (handle_ >= 0) {
        LJM_Close(handle_);
        handle_ = -1;
    }
}

}  // namespace t7
}  // namespace fsw
