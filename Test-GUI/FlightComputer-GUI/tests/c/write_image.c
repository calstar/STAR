/*
 * Writes an eMMC disk image with the firmware's own log writer
 * (firmware/Flight_Computer/src/app/emmc_log.c) so the GUI's Python decoder
 * is tested against the real writer, not against its own fake.
 *
 *   write_image <out.img>
 *
 * Two sessions: session 1 has 1000 IMU records (sample i: accel z raw = i,
 * gyro x raw = -i) and 100 baro records (pressure = 100000 + i Pa);
 * session 2 has 10 IMU records. Each IMU record's t_ms is i.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "emmc_log.h"

#define CAPACITY 4096U
#define DATA_START 64U
#define CHUNKS 4U

static uint8_t disk[CAPACITY * EMMC_BLOCK_SIZE];

static emmc_status_t d_start(void* c, uint32_t* n) { (void)c; *n = CAPACITY; return EMMC_OK; }
static emmc_status_t d_read(void* c, uint32_t lba, void* b, uint32_t n, uint32_t ms) {
    (void)c; (void)ms;
    if (lba + n > CAPACITY) return EMMC_ERR_PARAM;
    memcpy(b, disk + (size_t)lba * EMMC_BLOCK_SIZE, (size_t)n * EMMC_BLOCK_SIZE);
    return EMMC_OK;
}
static emmc_status_t d_write(void* c, uint32_t lba, const void* b, uint32_t n, uint32_t ms) {
    (void)c; (void)ms;
    if (lba + n > CAPACITY) return EMMC_ERR_PARAM;
    memcpy(disk + (size_t)lba * EMMC_BLOCK_SIZE, b, (size_t)n * EMMC_BLOCK_SIZE);
    return EMMC_OK;
}

#pragma pack(push, 1)
typedef struct { uint32_t t_us; int16_t temp, gyro[3], accel[3]; } imu_t;   /* records.h */
typedef struct { uint32_t t_us; int32_t temp_c100, pressure_pa; } baro_t;
#pragma pack(pop)

static emmc_log_t log_;
static emmc_log_chunk_t chunks[CHUNKS];
static uint8_t scratch[EMMC_BLOCK_SIZE];

static void drain(uint32_t now) {
    for (int i = 0; i < 200 && (emmc_log_backlog(&log_) || i == 0); ++i) {
        if (emmc_log_service(&log_, now) != EMMC_OK) { fprintf(stderr, "service failed\n"); exit(1); }
    }
}

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    emmc_port_t port = {d_start, d_read, d_write, NULL, NULL};
    emmc_log_config_t cfg = emmc_log_default_config();
    cfg.data_start_lba = DATA_START;
    if (emmc_log_init(&log_, &port, NULL, &cfg, chunks, CHUNKS, scratch) != EMMC_OK) return 1;

    uint32_t now = 0;
    emmc_log_on_state(&log_, FLIGHT_IDLE, FLIGHT_ARMED, now);
    for (int i = 0; i < 1000; ++i) {
        imu_t r = {(uint32_t)i * 1000U, 0, {(int16_t)-i, 0, 0}, {0, 0, (int16_t)i}};
        if (!emmc_log_append(&log_, 0x10, (uint32_t)i, &r, sizeof r)) { drain(now); --i; continue; }
        if (i % 10 == 0) {
            baro_t b = {(uint32_t)i * 1000U, 2500, 100000 + i / 10};
            while (!emmc_log_append(&log_, 0x12, (uint32_t)i, &b, sizeof b)) drain(now);
        }
        if (i % 50 == 0) drain(now);
    }
    emmc_log_on_state(&log_, FLIGHT_ARMED, FLIGHT_IDLE, 1000);
    drain(1000);

    emmc_log_on_state(&log_, FLIGHT_IDLE, FLIGHT_ARMED, 2000);
    for (int i = 0; i < 10; ++i) {
        imu_t r = {(uint32_t)i, 0, {0, 0, 0}, {0, 0, 1}};
        emmc_log_append(&log_, 0x10, (uint32_t)i, &r, sizeof r);
    }
    emmc_log_on_state(&log_, FLIGHT_ARMED, FLIGHT_IDLE, 3000);
    drain(3000);

    FILE* f = fopen(argv[1], "wb");
    if (!f) return 1;
    fwrite(disk, 1, sizeof disk, f);
    fclose(f);
    printf("%u\n", log_.head);
    return 0;
}
