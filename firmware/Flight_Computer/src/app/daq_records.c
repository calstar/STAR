#include "daq_records.h"

#include <stddef.h>
#include <string.h>

#include "records.h"

typedef struct {
    uint8_t type, offset, width;
    bool sign;
} field_t;
#define FIELD(type, rec, member, sign) \
    {type, offsetof(rec, member), sizeof(((rec*)0)->member), sign}
static const field_t fields[DAQ_SOURCE_COUNT] = {
    [DAQ_IMU_TEMP] = FIELD(REC_IMU, rec_imu_t, temp, true),
    [DAQ_GYRO_X] = FIELD(REC_IMU, rec_imu_t, gyro[0], true),
    [DAQ_GYRO_Y] = FIELD(REC_IMU, rec_imu_t, gyro[1], true),
    [DAQ_GYRO_Z] = FIELD(REC_IMU, rec_imu_t, gyro[2], true),
    [DAQ_ACCEL_X] = FIELD(REC_IMU, rec_imu_t, accel[0], true),
    [DAQ_ACCEL_Y] = FIELD(REC_IMU, rec_imu_t, accel[1], true),
    [DAQ_ACCEL_Z] = FIELD(REC_IMU, rec_imu_t, accel[2], true),
    [DAQ_HIGHG_X] = FIELD(REC_HIGHG, rec_highg_t, accel[0], true),
    [DAQ_HIGHG_Y] = FIELD(REC_HIGHG, rec_highg_t, accel[1], true),
    [DAQ_HIGHG_Z] = FIELD(REC_HIGHG, rec_highg_t, accel[2], true),
    [DAQ_BARO_TEMP] = FIELD(REC_BARO, rec_baro_t, temp_c100, true),
    [DAQ_BARO_PRESSURE] = FIELD(REC_BARO, rec_baro_t, pressure_pa, true),
    [DAQ_GNSS_LAT] = FIELD(REC_GNSS, rec_gnss_t, lat_e7, true),
    [DAQ_GNSS_LON] = FIELD(REC_GNSS, rec_gnss_t, lon_e7, true),
    [DAQ_GNSS_ALT] = FIELD(REC_GNSS, rec_gnss_t, hmsl_mm, true),
    [DAQ_GNSS_VN] = FIELD(REC_GNSS, rec_gnss_t, vel_n_mms, true),
    [DAQ_GNSS_VE] = FIELD(REC_GNSS, rec_gnss_t, vel_e_mms, true),
    [DAQ_GNSS_VD] = FIELD(REC_GNSS, rec_gnss_t, vel_d_mms, true),
    [DAQ_GNSS_FIX] = FIELD(REC_GNSS, rec_gnss_t, fix_type, false),
    [DAQ_GNSS_SATS] = FIELD(REC_GNSS, rec_gnss_t, num_sv, false),
};
#undef FIELD

bool daq_map_record(const daq_source_t sources[DAQ_CHANNELS], uint8_t type,
                    const void* data, uint8_t length, uint32_t ms,
                    daq_sample_t* out) {
    if (!sources || !data || !out)
        return false;
    *out = (daq_sample_t){.timestamp_ms = ms};
    size_t expected;
    switch (type) {
        case REC_IMU:
            expected = sizeof(rec_imu_t);
            break;
        case REC_HIGHG:
            expected = sizeof(rec_highg_t);
            break;
        case REC_BARO:
            expected = sizeof(rec_baro_t);
            break;
        case REC_GNSS:
            expected = sizeof(rec_gnss_t);
            break;
        default:
            return false;
    }
    if (length != expected)
        return false;
    for (unsigned i = 0; i < DAQ_CHANNELS; ++i) {
        if ((unsigned)sources[i] >= DAQ_SOURCE_COUNT)
            return false;
        const field_t* f = &fields[sources[i]];
        if (!sources[i] || f->type != type)
            continue;
        uint32_t value = 0;
        const uint8_t* p = (const uint8_t*)data + f->offset;
        for (unsigned j = 0; j < f->width; ++j)
            value |= (uint32_t)p[j] << (8 * j);
        if (f->sign && f->width < 4 && (p[f->width - 1] & 0x80))
            value |= UINT32_MAX << (8 * f->width);
        out->values[out->count++] = (daq_value_t){(uint8_t)(i + 1), value};
    }
    return out->count != 0;
}
