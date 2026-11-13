// Fills the firmware's StatusPacket and writes its raw bytes to stdout, so the
// page's decoder is checked against the C struct rather than against itself.
#include <cstdio>
#include "status.h"
int main() {
    StatusPacket p{};
    p.version = STATUS_VERSION;
    p.output = 1;
    p.sense = static_cast<uint8_t>(Sense::Live);
    p.flags = FLAG_INA_OK | FLAG_READING_VALID | FLAG_RESTORED;
    p.supply_mV = 8412;
    p.current_mA = -123;
    p.power_mW = 1035;
    p.sense_mV = 2471;
    p.uptime_s = 0x01020304;
    p.reset_reason = 9;
    fwrite(&p, sizeof p, 1, stdout);
}
