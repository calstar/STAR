#ifndef STAR_FC_CONFIG_H
#define STAR_FC_CONFIG_H

/*
 * The board's settings (Test-GUI/FlightComputer-GUI/PROTOCOL.md §5): the 18
 * fields, their blob, the checks and the flash records. No I/O.
 * Defaults are what the firmware did with constants before this file, so a
 * board with nothing saved behaves exactly as before.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Blob: header 4 + fields 35 + CRC-32 4. Record: "FCCF", sequence, blob,
 * padded to two 32-byte flash words. */
#define FC_CONFIG_VERSION 2U
#define FC_CONFIG_SIZE 43U
#define FC_CONFIG_RECORD 64U
#define FC_CONFIG_MAGIC 0x46434346UL

typedef struct {
    uint32_t radio_freq_hz;
    uint8_t radio_sf;
    uint32_t radio_bw_hz;
    uint8_t radio_cr; /* 5..8 = 4/5..4/8 */
    int8_t radio_tx_dbm;
    uint16_t radio_preamble;
    uint16_t radio_sync_word;
    uint16_t hb_self_test_ms; /* stored only: self-test sends nothing yet */
    uint16_t hb_idle_ms;
    uint16_t hb_flight_ms; /* telemetry period once armed, >= 500 ms */
    uint16_t gnss_rate_ms;
    uint8_t gnss_dyn_model;
    uint8_t gnss_constellations;
    uint16_t imu_odr_hz;
    uint8_t imu_accel_fs_g;
    uint16_t imu_gyro_fs_dps;
    uint16_t highg_odr_hz;
    uint16_t baro_osr;
    uint8_t role; /* FC_ROLE_*: read at boot; a change applies after a reboot */
} fc_config_t;

#define FC_ROLE_TRANSMITTER 0U /* the flight computer */
#define FC_ROLE_RECEIVER 1U    /* the ground station */

fc_config_t fc_config_defaults(void);

/* 0 if every field is one the firmware can run, else the first bad field's
 * id (1..19, PROTOCOL.md order). */
uint8_t fc_config_check(const fc_config_t* c);

void fc_config_pack(const fc_config_t* c, uint8_t out[FC_CONFIG_SIZE]);
/* Same settings. Never memcmp the struct: its padding bytes are garbage. */
bool fc_config_equal(const fc_config_t* a, const fc_config_t* b);
/* false: wrong length, version, size or CRC (values not checked). */
bool fc_config_unpack(const uint8_t* blob, size_t len, fc_config_t* out);

/* Flash records: magic, sequence, blob. One record per FC_CONFIG_RECORD
 * bytes; an erased (0xFF) slot ends the list. */
void fc_config_record(const fc_config_t* c, uint32_t sequence,
                      uint8_t out[FC_CONFIG_RECORD]);
/* The valid record with the highest sequence in `sector`; false if none.
 * `slot_ok(i)` (may be NULL) says slot i can be read safely. *next_slot is
 * the first erased slot, or the slot count if the sector is full. */
bool fc_config_find(const uint8_t* sector, size_t size,
                    bool (*slot_ok)(size_t slot), fc_config_t* out,
                    uint32_t* sequence, size_t* next_slot);

#ifdef __cplusplus
}
#endif
#endif
