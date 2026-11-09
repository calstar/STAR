/* fc_config: defaults, checks, the blob, and finding the newest record. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fc_config.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

static void test_defaults_are_allowed_and_round_trip(void) {
    fc_config_t d = fc_config_defaults(), back;
    uint8_t blob[FC_CONFIG_SIZE];
    CHECK(fc_config_check(&d) == 0);
    fc_config_pack(&d, blob);
    CHECK(fc_config_unpack(blob, sizeof blob, &back));
    CHECK(memcmp(&d, &back, sizeof d) == 0);
    blob[10] ^= 1; /* any flipped bit: the CRC refuses it */
    CHECK(!fc_config_unpack(blob, sizeof blob, &back));
    CHECK(!fc_config_unpack(blob, sizeof blob - 1, &back));
}

static void test_check_names_the_first_bad_field(void) {
    fc_config_t c = fc_config_defaults();
    c.radio_freq_hz = 927950000UL; /* 125 kHz wide: spills past 928 MHz */
    CHECK(fc_config_check(&c) == 1);
    c = fc_config_defaults();
    c.radio_bw_hz = 62500; /* time-on-air knows 125/250/500 kHz only */
    CHECK(fc_config_check(&c) == 3);
    c = fc_config_defaults();
    c.hb_idle_ms = 500; /* Idle needs at least 1 s */
    CHECK(fc_config_check(&c) == 9);
    c = fc_config_defaults();
    c.highg_odr_hz = 1000; /* not a normal-mode rate on the H3LIS100DL */
    CHECK(fc_config_check(&c) == 17);
    c.radio_sf = 5; /* two bad: the first is named */
    CHECK(fc_config_check(&c) == 2);
}

static void test_newest_record_wins_and_torn_slots_are_skipped(void) {
    static uint8_t sector[8 * FC_CONFIG_RECORD];
    fc_config_t a = fc_config_defaults(), b = a, got;
    uint32_t seq;
    size_t next;
    memset(sector, 0xFF, sizeof sector);
    CHECK(!fc_config_find(sector, sizeof sector, NULL, &got, &seq, &next));
    CHECK(next == 0);
    b.radio_tx_dbm = 10;
    fc_config_record(&a, 1, sector);
    fc_config_record(&b, 2, sector + FC_CONFIG_RECORD);
    CHECK(fc_config_find(sector, sizeof sector, NULL, &got, &seq, &next));
    CHECK(seq == 2 && got.radio_tx_dbm == 10 && next == 2);
    /* A torn third write: garbage where a record was going. */
    memset(sector + 2 * FC_CONFIG_RECORD, 0x5A, 20);
    CHECK(fc_config_find(sector, sizeof sector, NULL, &got, &seq, &next));
    CHECK(seq == 2 && next == 3); /* the next write goes past the torn one */
    memset(sector + 3 * FC_CONFIG_RECORD, 0x5A, 5 * FC_CONFIG_RECORD);
    CHECK(fc_config_find(sector, sizeof sector, NULL, &got, &seq, &next));
    CHECK(seq == 2 && next == 8); /* no erased slot left: "full" */
}

static bool not_slot_1(size_t slot) {
    return slot != 1;
}

static void test_unreadable_slot_is_skipped(void) {
    static uint8_t sector[4 * FC_CONFIG_RECORD];
    fc_config_t a = fc_config_defaults(), b = a, got;
    uint32_t seq;
    size_t next;
    memset(sector, 0xFF, sizeof sector);
    b.radio_tx_dbm = 10;
    fc_config_record(&a, 1, sector);
    fc_config_record(&b, 2, sector + FC_CONFIG_RECORD);
    CHECK(fc_config_find(sector, sizeof sector, not_slot_1, &got, &seq, &next));
    CHECK(seq == 1 && got.radio_tx_dbm == 22 && next == 2);
}

int main(void) {
    test_defaults_are_allowed_and_round_trip();
    test_check_names_the_first_bad_field();
    test_newest_record_wins_and_torn_slots_are_skipped();
    test_unreadable_slot_is_skipped();
    printf("test_fc_config: ok\n");
    return 0;
}
