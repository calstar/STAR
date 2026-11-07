// C interface to the IT9303 bridge + IT9133 demod in the UT-130.
#ifndef HIDES_RX_H
#define HIDES_RX_H
#include <stdint.h>

// Performs one bulk transfer. Returns 0 on success.
typedef int (*hides_bulk_fn)(void *ctx, uint8_t endpoint, uint8_t *buf, uint32_t len, uint32_t timeout_ms);

#define HIDES_EP_CMD_OUT 0x02
#define HIDES_EP_CMD_IN 0x81
#define HIDES_EP_TS_IN 0x84

typedef enum {
    HIDES_MIXER_NONE = 0,
    HIDES_MIXER_ADRF6655 = 1,
    HIDES_MIXER_RFFC2072 = 2,
    HIDES_MIXER_RFFC2071 = 3,
} hides_mixer;

typedef struct {
    uint8_t eeprom_valid;
    uint8_t board_id;
    uint8_t bridge_count;
    uint8_t receiver_count;
    uint8_t chip_type;
    uint8_t tuner_id;
    uint8_t support_bw;
    uint16_t bridge_chip;
    hides_mixer mixer;
    uint32_t lo1_khz;
    uint32_t lo2_khz;
} hides_rx_info;

typedef struct {
    uint8_t tps_locked;
    uint8_t mpeg_locked;
    uint8_t strength_percent;
    uint8_t quality_percent;
    int32_t strength_dbm;
    uint8_t snr_db;
    // Bit errors after Viterbi over the demod's last measurement window.
    uint32_t post_viterbi_errors;
    uint32_t post_viterbi_bits;
    // Reed-Solomon packets that could not be corrected in that window.
    uint16_t uncorrected_packets;
} hides_rx_status;

// TPS parameters as signalled by the transmitter. Values follow the vendor enums:
// fft 0=2K 1=8K 2=4K; constellation 0=QPSK 1=16QAM 2=64QAM; guard 0=1/32 .. 3=1/4;
// code rate 0=1/2 1=2/3 2=3/4 3=5/6 4=7/8; hierarchy 0=none.
typedef struct {
    uint8_t fft_mode;
    uint8_t constellation;
    uint8_t guard_interval;
    uint8_t code_rate;
    uint8_t hierarchy;
} hides_rx_modulation;

void hides_rx_set_transport(hides_bulk_fn fn, void *ctx);
uint32_t hides_rx_read_info(hides_rx_info *info);
uint32_t hides_rx_init(void);
uint32_t hides_rx_tune(uint32_t rf_khz, uint16_t bandwidth_khz);
uint32_t hides_rx_get_status(hides_rx_status *status);
// Only meaningful while TPS is locked.
uint32_t hides_rx_get_modulation(hides_rx_modulation *modulation);
uint32_t hides_rx_set_streaming(int enabled);

// Pure tuning arithmetic, separated so it can be tested without hardware.
typedef struct {
    uint32_t if_khz;      // Frequency the demod tunes to.
    uint32_t lo_khz;      // 0 means the direct path, no mixer.
    uint8_t use_mixer;    // Value for GPIOH7.
    uint8_t use_lo1_path; // Lower band: GPIO 0xD8E3 on ADRF6655, GPIOH3 on RFFC2071.
} hides_tune_plan;
uint32_t hides_rx_plan_tune(hides_mixer mixer, uint32_t lo1_khz, uint32_t lo2_khz, uint32_t rf_khz, hides_tune_plan *plan);

// RFFC2071 PLL registers 0x0F, 0x10 and 0x11 for a local oscillator frequency.
void hides_rffc2071_lo_registers(uint32_t lo_khz, uint16_t registers[3]);

// Register 1 read back from the RFFC2071 during init. 0x4064 was written to it.
uint16_t hides_rx_mixer_readback(void);

#define HIDES_ERR_UNSUPPORTED_MIXER 0xE0000001u
#define HIDES_ERR_NARROW_BW 0xE0000002u
#define HIDES_ERR_NO_LO 0xE0000003u
#define HIDES_ERR_MIXER_NO_RESPONSE 0xE0000004u
#endif
