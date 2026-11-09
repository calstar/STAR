#include "status_report.h"

#include <string.h>

static uint8_t* put(uint8_t* p, uint32_t v, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        *p++ = (uint8_t)(v >> (8U * i));
    }
    return p;
}

static uint32_t get(const uint8_t** p, size_t n) {
    uint32_t v = 0;
    for (size_t i = 0; i < n; ++i) {
        v |= (uint32_t)(*p)[i] << (8U * i);
    }
    *p += n;
    return v;
}

/* state u8, uptime_ms u32, sequence u32, adc u16 x7, battery_mv u16,
 * flags u8, live_mask u8, chips {result u8, value u8} x8, radio errors u16 */
void status_report_pack(const status_report_t* r,
                        uint8_t out[STATUS_REPORT_LEN]) {
    uint8_t* p = out;
    p = put(p, r->state, 1);
    p = put(p, r->uptime_ms, 4);
    p = put(p, r->sequence, 4);
    for (int i = 0; i < STATUS_ADC_COUNT; ++i) {
        p = put(p, r->adc[i], 2);
    }
    p = put(p, r->battery_mv, 2);
    p = put(p, r->flags, 1);
    p = put(p, r->live_mask, 1);
    for (int i = 0; i < STATUS_CHIP_COUNT; ++i) {
        p = put(p, r->chips[i].result, 1);
        p = put(p, r->chips[i].value, 1);
    }
    put(p, r->radio_device_errors, 2);
}

bool status_report_unpack(const uint8_t* p, size_t len, status_report_t* r) {
    if (len != STATUS_REPORT_LEN) {
        return false;
    }
    r->state = (uint8_t)get(&p, 1);
    r->uptime_ms = get(&p, 4);
    r->sequence = get(&p, 4);
    for (int i = 0; i < STATUS_ADC_COUNT; ++i) {
        r->adc[i] = (uint16_t)get(&p, 2);
    }
    r->battery_mv = (uint16_t)get(&p, 2);
    r->flags = (uint8_t)get(&p, 1);
    r->live_mask = (uint8_t)get(&p, 1);
    for (int i = 0; i < STATUS_CHIP_COUNT; ++i) {
        r->chips[i].result = (uint8_t)get(&p, 1);
        r->chips[i].value = (uint8_t)get(&p, 1);
    }
    r->radio_device_errors = (uint16_t)get(&p, 2);
    return true;
}

/* state u8, uptime_ms u32, fresh u8, rec_imu_t 18, rec_highg_t 7,
 * rec_baro_t 12 (records.h, as-is), lat/lon/hmsl i32, fix u8, sats u8 */
void telemetry_pack(const telemetry_t* t, uint8_t out[TELEMETRY_LEN]) {
    uint8_t* p = out;
    p = put(p, t->state, 1);
    p = put(p, t->uptime_ms, 4);
    p = put(p, t->fresh, 1);
    memcpy(p, &t->imu, sizeof t->imu); /* packed little-endian structs */
    p += sizeof t->imu;
    memcpy(p, &t->highg, sizeof t->highg);
    p += sizeof t->highg;
    memcpy(p, &t->baro, sizeof t->baro);
    p += sizeof t->baro;
    p = put(p, (uint32_t)t->lat_e7, 4);
    p = put(p, (uint32_t)t->lon_e7, 4);
    p = put(p, (uint32_t)t->hmsl_mm, 4);
    p = put(p, t->fix_type, 1);
    put(p, t->num_sv, 1);
}

bool telemetry_unpack(const uint8_t* p, size_t len, telemetry_t* t) {
    if (len != TELEMETRY_LEN) {
        return false;
    }
    t->state = (uint8_t)get(&p, 1);
    t->uptime_ms = get(&p, 4);
    t->fresh = (uint8_t)get(&p, 1);
    memcpy(&t->imu, p, sizeof t->imu);
    p += sizeof t->imu;
    memcpy(&t->highg, p, sizeof t->highg);
    p += sizeof t->highg;
    memcpy(&t->baro, p, sizeof t->baro);
    p += sizeof t->baro;
    t->lat_e7 = (int32_t)get(&p, 4);
    t->lon_e7 = (int32_t)get(&p, 4);
    t->hmsl_mm = (int32_t)get(&p, 4);
    t->fix_type = (uint8_t)get(&p, 1);
    t->num_sv = (uint8_t)get(&p, 1);
    return true;
}
