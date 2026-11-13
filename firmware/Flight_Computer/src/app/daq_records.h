#ifndef STAR_DAQ_RECORDS_H
#define STAR_DAQ_RECORDS_H
#include "daq_wire.h"

/* Source selection per DAQ channel (array index + 1). Explicit, deployment
 * supplied: no claim that a flight measurement is a PT/LC ADC reading. */
typedef enum {
    DAQ_NONE = 0,
    DAQ_IMU_TEMP,
    DAQ_GYRO_X,
    DAQ_GYRO_Y,
    DAQ_GYRO_Z,
    DAQ_ACCEL_X,
    DAQ_ACCEL_Y,
    DAQ_ACCEL_Z,
    DAQ_HIGHG_X,
    DAQ_HIGHG_Y,
    DAQ_HIGHG_Z,
    DAQ_BARO_TEMP,
    DAQ_BARO_PRESSURE,
    DAQ_GNSS_LAT,
    DAQ_GNSS_LON,
    DAQ_GNSS_ALT,
    DAQ_GNSS_VN,
    DAQ_GNSS_VE,
    DAQ_GNSS_VD,
    DAQ_GNSS_FIX,
    DAQ_GNSS_SATS,
    DAQ_SOURCE_COUNT
} daq_source_t;

/* Copies only fields actually present in this fresh record. Signed fields
 * are sign-extended to 32-bit two's complement. No float reinterpretation. */
bool daq_map_record(const daq_source_t sources[DAQ_CHANNELS], uint8_t type,
                    const void* data, uint8_t length, uint32_t timestamp_ms,
                    daq_sample_t* out);
#endif
