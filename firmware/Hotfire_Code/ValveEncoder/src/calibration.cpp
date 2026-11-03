#include "calibration.h"

#include <Preferences.h>

namespace {
constexpr const char* NS = "valvecal";  // NVS namespace, max 15 chars
}

namespace calibration {

void load(valve::Calibration& cal, float default_tolerance_deg) {
    Preferences prefs;
    prefs.begin(NS, /*readOnly=*/true);
    cal.has_closed = prefs.isKey("closed");
    cal.has_open = prefs.isKey("open");
    cal.closed_raw = prefs.getUShort("closed", 0);
    cal.open_raw = prefs.getUShort("open", 0);
    cal.tolerance =
        prefs.getUShort("tol", valve::degToCounts(default_tolerance_deg));
    prefs.end();
}

bool save(const valve::Calibration& cal) {
    Preferences prefs;
    if (!prefs.begin(NS, /*readOnly=*/false))
        return false;
    bool ok = true;
    if (cal.has_closed)
        ok &= prefs.putUShort("closed", cal.closed_raw) == sizeof(uint16_t);
    if (cal.has_open)
        ok &= prefs.putUShort("open", cal.open_raw) == sizeof(uint16_t);
    ok &= prefs.putUShort("tol", cal.tolerance) == sizeof(uint16_t);
    prefs.end();
    return ok;
}

void clear() {
    Preferences prefs;
    prefs.begin(NS, /*readOnly=*/false);
    prefs.clear();
    prefs.end();
}

}  // namespace calibration
