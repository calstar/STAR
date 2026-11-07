#include "bench_task.h"

#ifdef STAR_BENCH
#include <stdarg.h>
#include <stdio.h>

#include "board.h"
#include "board_time.h"
#include "board_uart9.h"
#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "gnss_task.h"
#include "mode.h"
#include "radio_task.h"
#include "rtt_log.h"
#include "sensors_task.h"

/*
 * Bench build only (STAR_BENCH): five times a second, one line per sensor
 * to the RTT terminal (scripts/serial.sh). Integer math only: newlib-nano's
 * printf has no %f. Units: ISM330DHCX accel 0.488 mg/LSB, gyro 140 mdps/LSB,
 * temp 25 + raw/256 degC; H3LIS100DL 780 mg/digit; MS5611 compensated.
 */

/* 1: print only the GPS, once a second (antenna check). 0: every sensor,
 * the GPS and the eMMC, five times a second, plus the 10 s ARMED eMMC test. */
#ifndef BENCH_GPS_ONLY
#define BENCH_GPS_ONLY 1
#endif

/* Radio link test between two boards (env:bench_rx / env:bench_tx):
 * 1 = receive and report every frame, 2 = send one frame a second. 0 = off.
 */
#ifndef BENCH_RADIO
#define BENCH_RADIO 0
#endif
#ifndef BENCH_TX_PERIOD_MS
#define BENCH_TX_PERIOD_MS 1000U
#endif

static void say(const char* fmt, ...) __attribute__((format(printf, 1, 2)));

static void say(const char* fmt, ...) {
    char line[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);
    if (n > 0) {
        (void)rtt_log_write(line, n < (int)sizeof line ? (uint32_t)n
                                                       : sizeof line - 1U);
    }
}

static const char* disk_name(emmc_disk_state_t d) {
    switch (d) {
        case EMMC_DISK_UNMOUNTED:
            return "unmounted";
        case EMMC_DISK_MOUNTED:
            return "MOUNTED";
        case EMMC_DISK_FULL:
            return "FULL";
        default:
            return "FAULT";
    }
}

/* eMMC: card identity once it is up, then the log's progress. */
static void emmc_line(const char* phase) {
    const emmc_log_t* l = emmc_stm32_log();
    uint32_t issues = 0;
    const emmc_card_info_t* c = emmc_stm32_card(&issues);
    say("         eMMC   %-9s %-9s records %lu  chunks written %lu  "
        "write errors %lu  dropped %lu  backlog %u\r\n",
        phase, disk_name(l->disk), (unsigned long)l->stats.records,
        (unsigned long)l->stats.chunks_written,
        (unsigned long)l->stats.write_errors, (unsigned long)l->stats.dropped,
        emmc_log_backlog(l));
    static bool card_said;
    if (c && !card_said) {
        card_said = true;
        say("         eMMC   card: maker 0x%02x  part %s  rev %u  %lu MB  "
            "serial %08lx  life used A/B %u/%u (1 = 0-10%%)  pre-EOL %u  "
            "issues 0x%02lx  session %lu at LBA %lu\r\n",
            c->mid, c->pnm, c->ext_csd_rev,
            (unsigned long)(c->sec_count / 2048U), (unsigned long)c->psn,
            c->life_a, c->life_b, c->pre_eol, (unsigned long)issues,
            (unsigned long)l->base_session, (unsigned long)l->head);
    }
}

static long mg(long raw, long ug_per_lsb) {
    return raw * ug_per_lsb / 1000L;
}

#if BENCH_GPS_ONLY
/* 1e-7 degrees as signed decimal degrees, e.g. "37.8715926". */
static void deg_e7(char* out, size_t n, int32_t v) {
    long a = v < 0 ? -(long)v : (long)v;
    snprintf(out, n, "%s%ld.%07ld", v < 0 ? "-" : "", a / 10000000L,
             a % 10000000L);
}

static const char* fix_name(uint8_t t) {
    switch (t) {
        case 0:
            return "none";
        case 1:
            return "DR";
        case 2:
            return "2D";
        case 3:
            return "3D";
        case 4:
            return "GNSS+DR";
        case 5:
            return "time";
        default:
            return "?";
    }
}

/* GPS only, once a second: for checking the antenna. No other lines and no
 * ARMED eMMC test; the board stays in SELF_TEST. */
static void gps_only_loop(void) {
    uint32_t last_fix = 0;
    uint32_t last_ms = osKernelGetTickCount();
    say("\r\nSTAR flight computer bench build: GPS only (BENCH_GPS_ONLY)\r\n");
    gnss_task_poll_status(true); /* MON-RF + NAV-SAT once a second */
    for (;;) {
        osDelay(1000);
        const gnss_core_t* g = gnss_task_core();
        const rec_gnss_t* f = &g->latest;
        uint32_t now = osKernelGetTickCount(), dt = now - last_ms;
        last_ms = now;
        uint32_t hz = dt ? (g->fixes - last_fix) * 1000U / dt : 0U;
        last_fix = g->fixes;
        const char* st = g->state == GNSS_RUN      ? "run"
                         : g->state == GNSS_CONFIG ? "config"
                                                   : "detect";
        char lat[16], lon[16];
        deg_e7(lat, sizeof lat, f->lat_e7);
        deg_e7(lon, sizeof lon, f->lon_e7);
        /* listen: the baud the task is on now; heard: the last baud a valid
         * frame came in at (0 = none yet). rx/err/ovf: UART9 since boot. */
        say("t=%lus  GPS %-6s listen %lu heard %lu  rx %lu err %lu ovf %lu  "
            "%2luHz  fix %-7s sats %2u  "
            "lat %s  lon %s  alt %ld m  hacc %lu m  pdop %u.%02u\r\n",
            (unsigned long)(now / 1000U), st, (unsigned long)g->baud,
            (unsigned long)g->detected_baud,
            (unsigned long)board_uart9_rx_bytes(),
            (unsigned long)board_uart9_errors(),
            (unsigned long)board_uart9_overflows(), (unsigned long)hz,
            fix_name(f->fix_type), f->num_sv, lat, lon,
            (long)(f->hmsl_mm / 1000), (unsigned long)(f->hacc_mm / 1000U),
            f->pdop_e2 / 100U, f->pdop_e2 % 100U);
        static const char* const ant[] = {"init", "unknown", "OK", "SHORT",
                                          "OPEN"};
        static const char* const pwr[] = {"off", "on", "unknown"};
        static const char* const jam[] = {"unknown", "ok", "WARNING",
                                          "CRITICAL"};
        const ubx_rf_t* r = &g->rf;
        const ubx_sats_t* v = &g->sats;
        say("         antenna %s (power %s)  jamming %s  noise %u  agc %u  "
            "| sats listed %u signal %u locked %u used %u  best %u dB-Hz  "
            "(reports rf %lu sat %lu)\r\n",
            r->ant_status < 5U ? ant[r->ant_status] : "?",
            r->ant_power < 3U ? pwr[r->ant_power] : "?", jam[r->jamming & 3U],
            r->noise, r->agc, v->listed, v->with_signal, v->locked, v->used,
            v->best_cno, (unsigned long)g->rf_reports,
            (unsigned long)g->sat_reports);
    }
}

#endif /* BENCH_GPS_ONLY */

#if BENCH_RADIO
/* Half and quarter units to "-90.5" / "-5.25" without %f. */
static void fixed(char* out, size_t n, long v, long den) {
    long a = v < 0 ? -v : v;
    long frac = (a % den) * (den == 2 ? 5 : 25);
    snprintf(out, n, "%s%ld.%0*ld", v < 0 ? "-" : "", a / den, den == 2 ? 1 : 2,
             frac);
}

static void radio_header(const char* role) {
    radio_status_t st;
    radio_task_status(&st);
    say("\r\nSTAR flight computer bench build: radio link test, %s\r\n"
        "  LoRa 915 MHz, SF9, BW 125 kHz, CR 4/5, sync 0x1424"
#ifdef STAR_RADIO_POWER_DBM
        ", TX power %d dBm"
#endif
        "\r\n",
        role
#ifdef STAR_RADIO_POWER_DBM
        ,
        STAR_RADIO_POWER_DBM
#endif
    );
}

/* Wait for the radio task's start-up (configure()); report the failing
 * step while it retries every 5 s. */
static void wait_radio_ready(void) {
    for (;;) {
        radio_status_t st;
        radio_task_status(&st);
        if (st.setup_attempts > 0U && st.setup_step == 0U) {
            say("  radio ready (start-up attempt %lu)\r\n",
                (unsigned long)st.setup_attempts);
            return;
        }
        if (st.setup_attempts > 0U) {
            say("  radio NOT ready: start-up stopped at step %u (attempt %lu, "
                "device errors 0x%04x); retrying\r\n",
                st.setup_step, (unsigned long)st.setup_attempts,
                st.device_errors);
        }
        osDelay(st.setup_attempts > 0U ? 5000U : 200U);
    }
}

#if BENCH_RADIO == 1
static void radio_rx_loop(void) {
    radio_header("RX (this board listens)");
    wait_radio_ready();
    uint32_t seen = 0, got = 0, last_report = osKernelGetTickCount();
    uint16_t first_seq = 0, last_seq = 0;
    long rssi_sum = 0, snr_sum = 0;
    int best_rssi = -1000, worst_rssi = 1000;
    for (;;) {
        osDelay(20);
        radio_rx_t rx;
        radio_task_last_rx(&rx);
        uint32_t now = osKernelGetTickCount();
        if (rx.count != seen) {
            uint32_t missed_here = rx.count - seen - 1U; /* not seen by us */
            seen = rx.count;
            if (got == 0U || (uint16_t)(rx.seq - last_seq) > 1000U) {
                if (got != 0U) {
                    say("  -- sequence jumped %u -> %u: the TX board "
                        "restarted, counting again --\r\n",
                        last_seq, rx.seq);
                }
                first_seq = rx.seq;
                got = 0;
                rssi_sum = snr_sum = 0;
                best_rssi = -1000;
                worst_rssi = 1000;
            }
            got += 1U + missed_here;
            last_seq = rx.seq;
            uint32_t sent = (uint16_t)(rx.seq - first_seq) + 1U;
            uint32_t lost = sent > got ? sent - got : 0U;
            rssi_sum += rx.rssi_x2;
            snr_sum += rx.snr_x4;
            if (rx.rssi_x2 > best_rssi)
                best_rssi = rx.rssi_x2;
            if (rx.rssi_x2 < worst_rssi)
                worst_rssi = rx.rssi_x2;
            radio_status_t st;
            radio_task_status(&st);
            char rssi[12], snr[12];
            fixed(rssi, sizeof rssi, rx.rssi_x2, 2);
            fixed(snr, sizeof snr, rx.snr_x4, 4);
            uint32_t counter = 0;
            if (rx.payload_len >= 5U && rx.payload[0] == 'T') {
                counter = (uint32_t)rx.payload[1] |
                          (uint32_t)rx.payload[2] << 8 |
                          (uint32_t)rx.payload[3] << 16 |
                          (uint32_t)rx.payload[4] << 24;
            }
            say("t=%lu.%03lus  RX seq %5u type 0x%02x len %u  RSSI %s dBm  "
                "SNR %s dB%s | got %lu of %lu  lost %lu  CRC errors %lu  "
                "bad frames %lu  (TX count %lu)\r\n",
                (unsigned long)(now / 1000U), (unsigned long)(now % 1000U),
                rx.seq, rx.type, rx.payload_len, rssi, snr,
                rx.quality_ok ? "" : " (no status)", (unsigned long)got,
                (unsigned long)sent, (unsigned long)lost,
                (unsigned long)st.crc_errors, (unsigned long)st.frames_dropped,
                (unsigned long)counter);
            last_report = now;
        } else if (now - last_report >= 5000U) {
            radio_status_t st;
            radio_task_status(&st);
            if (got) {
                char avg_rssi[12], avg_snr[12], lo[12], hi[12];
                fixed(avg_rssi, sizeof avg_rssi, rssi_sum / (long)seen, 2);
                fixed(avg_snr, sizeof avg_snr, snr_sum / (long)seen, 4);
                fixed(lo, sizeof lo, worst_rssi, 2);
                fixed(hi, sizeof hi, best_rssi, 2);
                say("t=%lus  ... nothing for 5 s. So far: got %lu, avg RSSI %s "
                    "dBm (%s .. %s), avg SNR %s dB, CRC errors %lu\r\n",
                    (unsigned long)(now / 1000U), (unsigned long)got, avg_rssi,
                    lo, hi, avg_snr, (unsigned long)st.crc_errors);
            } else {
                say("t=%lus  listening... no frames yet  (CRC errors %lu, "
                    "bad frames %lu, radio errors %lu)\r\n",
                    (unsigned long)(now / 1000U), (unsigned long)st.crc_errors,
                    (unsigned long)st.frames_dropped,
                    (unsigned long)st.radio_errors);
            }
            last_report = now;
        }
    }
}
#endif /* BENCH_RADIO == 1 */

#if BENCH_RADIO == 2
static void radio_tx_loop(void) {
    radio_header("TX (this board sends one frame a second)");
    wait_radio_ready();
    uint32_t counter = 0, next = osKernelGetTickCount();
    for (;;) {
        next += BENCH_TX_PERIOD_MS;
        /* Heartbeat-sized test payload: 'T', counter (u32 LE), 2 spare. */
        uint8_t p[7] = {'T',
                        (uint8_t)counter,
                        (uint8_t)(counter >> 8),
                        (uint8_t)(counter >> 16),
                        (uint8_t)(counter >> 24),
                        0,
                        0};
        uint32_t t0 = board_now_ms();
        radio_send_result_t r =
            radio_task_send_frame(0x01 /* Heartbeat */, p, sizeof p);
        uint32_t took = board_now_ms() - t0;
        radio_status_t st;
        radio_task_status(&st);
        static const char* const names[] = {"OK", "TIMEOUT (no TxDone)",
                                            "NO RADIO", "BAD FRAME"};
        uint32_t now = osKernelGetTickCount();
        say("t=%lu.%03lus  TX #%lu  %s in %lu ms  | sent ok %lu  timeouts %lu"
            "\r\n",
            (unsigned long)(now / 1000U), (unsigned long)(now % 1000U),
            (unsigned long)counter, r < 4 ? names[r] : "?", (unsigned long)took,
            (unsigned long)st.tx_ok, (unsigned long)st.tx_timeouts);
        counter++;
        int32_t wait = (int32_t)(next - osKernelGetTickCount());
        osDelay(wait > 0 ? (uint32_t)wait : 1U);
    }
}
#endif /* BENCH_RADIO == 2 */
#endif /* BENCH_RADIO */

static void bench_task(void* argument) {
    (void)argument;
#if BENCH_RADIO == 1
    radio_rx_loop();
#elif BENCH_RADIO == 2
    radio_tx_loop();
#endif
#if BENCH_GPS_ONLY
    gps_only_loop();
#endif
    static sensors_core_t s; /* static: the snapshot is too big for a stack */
    uint32_t last_imu = 0, last_highg = 0, last_baro = 0, last_fix = 0;
    uint32_t last_ms = osKernelGetTickCount();
    say("\r\nSTAR flight computer bench build: sensors + GPS live, no Idle, "
        "no eMMC, no pyro\r\n");
    /* One 10 s recording (ARMED: sensors + GPS to the eMMC, never pyro),
     * starting at 5 s, then back to SELF_TEST. */
    const uint32_t rec_start_ms = 5000U, rec_stop_ms = 15000U;
    bool rec_started = false, rec_stopped = false;
    for (;;) {
        osDelay(200);
        uint32_t up = osKernelGetTickCount();
        if (!rec_started && up >= rec_start_ms) {
            rec_started = true;
            say("--- eMMC test: ARMED for 10 s, recording ---\r\n");
            app_set_state(FLIGHT_ARMED);
        } else if (rec_started && !rec_stopped && up >= rec_stop_ms) {
            rec_stopped = true;
            app_set_state(FLIGHT_SELF_TEST);
            sensors_task_set_active(true); /* SELF_TEST stops them: */
            gnss_task_set_active(true);    /* keep the bench stream going */
            say("--- eMMC test: stopped, flushing ---\r\n");
        }
        emmc_line(!rec_started  ? "waiting"
                  : rec_stopped ? "done"
                                : "RECORDING");
        sensors_task_snapshot(&s);
        const gnss_core_t* g = gnss_task_core();
        uint32_t now = osKernelGetTickCount(), dt = now - last_ms;
        last_ms = now;
        /* Rates from the sample counters over the last interval. */
        uint32_t imu_hz = (s.imu.samples - last_imu) * 1000U / dt;
        uint32_t hg_hz = (s.highg.samples - last_highg) * 1000U / dt;
        uint32_t baro_hz = (s.baro.samples - last_baro) * 1000U / dt;
        last_imu = s.imu.samples;
        last_highg = s.highg.samples;
        last_baro = s.baro.samples;

        const rec_imu_t* i = &s.imu_latest;
        long t100 = 2500L + (long)i->temp * 100L / 256L;
        say("t=%lu.%01lus  IMU %s %3luHz  acc mg %6ld %6ld %6ld  "
            "gyro dps %5ld %5ld %5ld  %ld.%02ldC\r\n",
            (unsigned long)(now / 1000U), (unsigned long)(now % 1000U / 100U),
            s.imu.ok ? "ok " : "ERR", (unsigned long)imu_hz,
            mg(i->accel[0], 488), mg(i->accel[1], 488), mg(i->accel[2], 488),
            (long)i->gyro[0] * 140L / 1000L, (long)i->gyro[1] * 140L / 1000L,
            (long)i->gyro[2] * 140L / 1000L, t100 / 100L,
            (t100 < 0 ? -t100 : t100) % 100L);

        const rec_highg_t* h = &s.highg_latest;
        say("         high-g %s %3luHz  acc mg %6ld %6ld %6ld\r\n",
            s.highg.ok ? "ok " : "ERR", (unsigned long)hg_hz,
            (long)h->accel[0] * 780L, (long)h->accel[1] * 780L,
            (long)h->accel[2] * 780L);

        const rec_baro_t* b = &s.baro_latest;
        long tc = b->temp_c100;
        say("         baro   %s %3luHz  %ld.%02ld hPa  %ld.%02ldC\r\n",
            s.baro.ok ? "ok " : "ERR", (unsigned long)baro_hz,
            (long)b->pressure_pa / 100L, (long)b->pressure_pa % 100L, tc / 100L,
            (tc < 0 ? -tc : tc) % 100L);

        const rec_gnss_t* f = &g->latest;
        const char* st = g->state == GNSS_RUN      ? "run"
                         : g->state == GNSS_CONFIG ? "config"
                                                   : "detect";
        say("         GPS    %-6s %lu baud  fixes %lu (+%lu)  fix %u  sats %u"
            "  lat %ld lon %ld (1e-7 deg)  alt %ld m\r\n",
            st, (unsigned long)g->detected_baud, (unsigned long)g->fixes,
            (unsigned long)(g->fixes - last_fix), f->fix_type, f->num_sv,
            (long)f->lat_e7, (long)f->lon_e7, (long)(f->hmsl_mm / 1000));
        last_fix = g->fixes;
    }
}

bool bench_task_start(void) {
    static const osThreadAttr_t attr = {
        .name = "bench",
        .stack_size = 2048,
        .priority = osPriorityLow,
    };
    rtt_log_init();
    return osThreadNew(bench_task, NULL, &attr) != NULL;
}
#endif /* STAR_BENCH */
