#include <stdio.h>
#include <stdlib.h>

#include "daq_records.h"
#include "records.h"
#define CHECK(x)                                            \
    do {                                                    \
        if (!(x)) {                                         \
            fprintf(stderr, "line %d: %s\n", __LINE__, #x); \
            abort();                                        \
        }                                                   \
    } while (0)
int main(void) {
    daq_source_t map[10] = {DAQ_HIGHG_X, DAQ_GYRO_X, DAQ_BARO_PRESSURE,
                            DAQ_GNSS_LON, DAQ_GNSS_FIX};
    daq_sample_t s;
    rec_highg_t hg = {.accel = {-128, 0, 127}};
    CHECK(daq_map_record(map, REC_HIGHG, &hg, sizeof(hg), 123, &s));
    CHECK(s.timestamp_ms == 123 && s.count == 1 && s.values[0].id == 1 &&
          s.values[0].value == 0xffffff80);
    rec_imu_t imu = {.gyro = {-32768, 123, 42}};
    CHECK(daq_map_record(map, REC_IMU, &imu, sizeof(imu), 124, &s));
    CHECK(s.count == 1 && s.values[0].id == 2 &&
          s.values[0].value == 0xffff8000);
    rec_baro_t baro = {.pressure_pa = 101325};
    CHECK(daq_map_record(map, REC_BARO, &baro, sizeof(baro), 125, &s));
    CHECK(s.count == 1 && s.values[0].id == 3 && s.values[0].value == 101325);
    rec_gnss_t gps = {.lon_e7 = -1220000000, .fix_type = 3};
    CHECK(daq_map_record(map, REC_GNSS, &gps, sizeof(gps), 126, &s));
    CHECK(s.count == 2 && s.values[0].id == 4 &&
          s.values[0].value == (uint32_t)-1220000000 && s.values[1].value == 3);
    CHECK(!daq_map_record(map, REC_IMU, &imu, sizeof(imu) - 1, 0, &s));
    CHECK(!daq_map_record(map, REC_EVENT, &imu, sizeof(imu), 0, &s));
    map[9] = DAQ_SOURCE_COUNT;
    CHECK(!daq_map_record(map, REC_IMU, &imu, sizeof(imu), 0, &s));
    puts("Record mapping checks passed");
}
