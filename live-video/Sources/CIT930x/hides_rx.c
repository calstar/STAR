// Glue between the ITE vendor API and a user-space USB transport.
//
// The bring-up order follows DRV_IT930x_device_init in the reference Linux
// driver. Tuning follows DRV_SetFreqBw in IT9300BDA.sys 24.10.07.1 (see
// docs/windows-stack-findings.md). Bring-up, tuning and streaming are confirmed on a
// board 0x35 UT-130.
#include "hides_rx.h"
#include "IT9300.h"
#include "IT9133.h"
#include "ADRF6655.h"
#include "tuner.h"

#define EEPROM_CHIP_IT913X 1
#define REG_EEPROM_BOARD_ID (OVA_EEPROM_CFG + 0x54)
#define REG_EEPROM_BRIDGE_COUNT (OVA_EEPROM_CFG + 0x38)
#define REG_EEPROM_CHIP_TYPE (OVA_EEPROM_CFG + 0x31)
#define REG_EEPROM_TUNER_ID 0x49DB
#define REG_EEPROM_LO 0x49D4
#define REG_EEPROM_SUPPORT_BW 0x49DA
#define REG_MIXER_ENABLE_O 0xD8C3
#define REG_MIXER_ENABLE_EN 0xD8C4
#define REG_MIXER_ENABLE_ON 0xD8C5
#define REG_LO_PATH_O 0xD8E3
#define REG_LO_PATH_EN 0xD8E4
#define REG_LO_PATH_ON 0xD8E5
#define REG_BAND_O 0xD8B3
#define REG_BAND_EN 0xD8B4
#define REG_BAND_ON 0xD8B5
#define REG_RFFC_ENABLE_ALT 0xD924
#define REG_RFFC_LATCH_O 0xD8BF
#define REG_RFFC_LATCH_EN 0xD8C0
#define REG_RFFC_LATCH_ON 0xD8C1
#define REG_RFFC_DATA_IN 0xD8CA
#define REG_RFFC_DATA_O 0xD8CB
#define REG_RFFC_DATA_EN 0xD8CC
#define REG_RFFC_DATA_ON 0xD8CD
#define REG_RFFC_CLOCK_O 0xD8CF
#define REG_RFFC_CLOCK_EN 0xD8D0
#define REG_RFFC_CLOCK_ON 0xD8D1
#define RFFC_REGISTER_COUNT 31
#define RFFC_SETTLE_MS 50
#define NARROW_BW_LIMIT_KHZ 5000
// Kept small because a transfer only completes once this much TS has arrived.
#define TS_PACKETS_PER_TRANSFER 32
#define DIRECT_MAX_KHZ 950000
#define LOWER_BAND_MAX_KHZ 1900000

static hides_bulk_fn g_bulk;
static void *g_bulk_ctx;
static Endeavour g_bridge;
static DefaultDemodulator g_demod;
static hides_rx_info g_info;
static int g_mixer_ready;
static uint16_t g_rffc_shadow[RFFC_REGISTER_COUNT];
static uint16_t g_rffc_readback;

// Register values from the init routine in IT9300BDA.sys.
static const uint16_t kRffcInitTable[RFFC_REGISTER_COUNT] = {
    0xFFFA, 0x4064, 0x9055, 0x2D02, 0xB0BF, 0xB0BF, 0x0028, 0x0028,
    0xFC06, 0x8224, 0x0207, 0x4F00, 0x2324, 0x6276, 0x2700, 0x1B96,
    0xC4E4, 0x4E00, 0x2A80, 0x0000, 0x0000, 0x0000, 0x70C1, 0x0000,
    0x0283, 0xF00F, 0x0000, 0x000F, 0xC002, 0x0001, 0x0001,
};

void hides_rx_set_transport(hides_bulk_fn fn, void *ctx) {
    g_bulk = fn;
    g_bulk_ctx = ctx;
    memset(&g_bridge, 0, sizeof(g_bridge));
    memset(&g_demod, 0, sizeof(g_demod));
    memset(&g_info, 0, sizeof(g_info));
    g_mixer_ready = 0;
    g_bridge.ctrlBus = BUS_USB;
    g_bridge.maxBusTxSize = 63;
    g_bridge.usbbus_timeout = 500;
}

// Set HIDES_TRACE=1 to log each control transfer to stderr.
static void trace(const char *direction, const Byte *buffer, Dword length) {
    static int enabled = -1;
    Dword i;
    if (enabled < 0) enabled = getenv("HIDES_TRACE") != NULL;
    if (!enabled) return;
    fprintf(stderr, "%s", direction);
    for (i = 0; i < length && i < 20; i++) fprintf(stderr, " %02X", buffer[i]);
    fprintf(stderr, "\n");
}

Dword Usb2_writeControlBus(Bridge *bridge, Dword length, Byte *buffer) {
    trace(">", buffer, length);
    return g_bulk(g_bulk_ctx, HIDES_EP_CMD_OUT, buffer, length, 500) ? BR_ERR_USB_WRITE_FAIL : BR_ERR_NO_ERROR;
}

Dword Usb2_readControlBus(Bridge *bridge, Dword length, Byte *buffer) {
    Dword error = g_bulk(g_bulk_ctx, HIDES_EP_CMD_IN, buffer, length, 500) ? BR_ERR_USB_READ_FAIL : BR_ERR_NO_ERROR;
    if (!error) trace("<", buffer, length);
    return error;
}

static uint32_t read_byte(Dword reg, uint8_t *value) {
    return IT9300_readRegisters(&g_bridge, 0, reg, 1, value);
}

uint32_t hides_rx_read_info(hides_rx_info *info) {
    uint32_t error;
    uint8_t lo[6];
    uint8_t chip[2];

    memset(&g_info, 0, sizeof(g_info));
    error = read_byte(OVA_EEPROM_CFG_VALID, &g_info.eeprom_valid);
    if (error) return error;
    error = IT9300_readRegisters(&g_bridge, 0, chip_version_7_0 + 1, 2, chip);
    if (error) return error;
    g_info.bridge_chip = (uint16_t)(chip[1] << 8 | chip[0]);

    if (g_info.eeprom_valid) {
        if ((error = read_byte(REG_EEPROM_BOARD_ID, &g_info.board_id))) return error;
        if ((error = read_byte(REG_EEPROM_BRIDGE_COUNT, &g_info.bridge_count))) return error;
        if ((error = read_byte(REG_EEPROM_BRIDGE_COUNT + 1, &g_info.receiver_count))) return error;
        if ((error = read_byte(REG_EEPROM_CHIP_TYPE, &g_info.chip_type))) return error;
        if ((error = read_byte(REG_EEPROM_TUNER_ID, &g_info.tuner_id))) return error;
        if ((error = read_byte(REG_EEPROM_SUPPORT_BW, &g_info.support_bw))) return error;
        if ((error = IT9300_readRegisters(&g_bridge, 0, REG_EEPROM_LO, 6, lo))) return error;
        g_info.lo1_khz = (uint32_t)lo[0] << 16 | (uint32_t)lo[1] << 8 | lo[2];
        g_info.lo2_khz = (uint32_t)lo[3] << 16 | (uint32_t)lo[4] << 8 | lo[5];
        switch (g_info.board_id) {
            case 0x31: g_info.mixer = HIDES_MIXER_ADRF6655; break;
            case 0x32: g_info.mixer = HIDES_MIXER_RFFC2072; break;
            case 0x35: g_info.mixer = HIDES_MIXER_RFFC2071; break;
            default: g_info.mixer = HIDES_MIXER_NONE; break;
        }
    }
    *info = g_info;
    return BR_ERR_NO_ERROR;
}

static void write_reg(Word reg, Byte value) {
    IT9300_writeRegister(&g_bridge, 0, reg, value);
}

// One 24-bit 3-wire frame, MSB first, sequenced as the Windows driver does it.
static void rffc_write(uint8_t reg, uint16_t value) {
    uint32_t frame = (uint32_t)reg << 16 | value;
    int bit;
    g_rffc_shadow[reg] = value;
    write_reg(REG_RFFC_CLOCK_O, 1);
    write_reg(REG_RFFC_LATCH_O, 0);
    write_reg(REG_RFFC_CLOCK_O, 0);
    write_reg(REG_RFFC_CLOCK_O, 1);
    for (bit = 23; bit >= 0; bit--) {
        write_reg(REG_RFFC_CLOCK_O, 0);
        write_reg(REG_RFFC_DATA_O, (frame >> bit) & 1);
        write_reg(REG_RFFC_CLOCK_O, 1);
    }
    write_reg(REG_RFFC_LATCH_O, 1);
    write_reg(REG_RFFC_CLOCK_O, 0);
}

static uint16_t rffc_read(uint8_t reg) {
    uint8_t address = reg | 0x80;
    uint16_t value = 0;
    Byte in = 0;
    int bit;
    write_reg(REG_RFFC_CLOCK_O, 1);
    write_reg(REG_RFFC_LATCH_O, 0);
    write_reg(REG_RFFC_CLOCK_O, 0);
    write_reg(REG_RFFC_CLOCK_O, 1);
    for (bit = 7; bit >= 0; bit--) {
        write_reg(REG_RFFC_CLOCK_O, 0);
        write_reg(REG_RFFC_DATA_O, (address >> bit) & 1);
        write_reg(REG_RFFC_CLOCK_O, 1);
    }
    write_reg(REG_RFFC_DATA_EN, 0);
    write_reg(REG_RFFC_DATA_ON, 1);
    write_reg(REG_RFFC_CLOCK_O, 0);
    write_reg(REG_RFFC_CLOCK_O, 1);
    write_reg(REG_RFFC_CLOCK_O, 0);
    write_reg(REG_RFFC_CLOCK_O, 1);
    for (bit = 0; bit < 16; bit++) {
        write_reg(REG_RFFC_CLOCK_O, 0);
        write_reg(REG_RFFC_DATA_EN, 0);
        write_reg(REG_RFFC_DATA_ON, 1);
        read_byte(REG_RFFC_DATA_IN, &in);
        write_reg(REG_RFFC_DATA_EN, 1);
        write_reg(REG_RFFC_DATA_ON, 1);
        value = (uint16_t)(value << 1 | (in & 1));
        write_reg(REG_RFFC_CLOCK_O, 1);
    }
    write_reg(REG_RFFC_LATCH_O, 1);
    write_reg(REG_RFFC_CLOCK_O, 0);
    write_reg(REG_RFFC_DATA_EN, 1);
    write_reg(REG_RFFC_DATA_ON, 1);
    return value;
}

static void rffc_set_enabled(int enabled) {
    write_reg(REG_LO_PATH_O, enabled ? 0 : 1);
    BrUser_delay((Bridge *)&g_bridge, 10);
    rffc_write(9, (uint16_t)(g_rffc_shadow[9] | 8));
}

static uint32_t rffc_init(void) {
    int reg;
    write_reg(REG_RFFC_ENABLE_ALT, 0);
    write_reg(REG_LO_PATH_EN, 1);
    write_reg(REG_LO_PATH_ON, 1);
    write_reg(REG_RFFC_LATCH_EN, 1);
    write_reg(REG_RFFC_LATCH_ON, 1);
    write_reg(REG_RFFC_CLOCK_EN, 1);
    write_reg(REG_RFFC_CLOCK_ON, 1);
    write_reg(REG_RFFC_DATA_EN, 1);
    write_reg(REG_RFFC_DATA_ON, 1);
    write_reg(REG_RFFC_LATCH_O, 1);
    write_reg(REG_RFFC_CLOCK_O, 0);
    write_reg(REG_RFFC_DATA_O, 0);
    rffc_set_enabled(0);
    for (reg = 0; reg < RFFC_REGISTER_COUNT; reg++) rffc_write((uint8_t)reg, kRffcInitTable[reg]);
    // Later writes modify the values read back here rather than the table.
    for (reg = 0; reg < RFFC_REGISTER_COUNT; reg++) g_rffc_shadow[reg] = rffc_read((uint8_t)reg);
    g_rffc_readback = g_rffc_shadow[1];
    if (g_rffc_readback == 0x0000 || g_rffc_readback == 0xFFFF) return HIDES_ERR_MIXER_NO_RESPONSE;
    return BR_ERR_NO_ERROR;
}

uint16_t hides_rx_mixer_readback(void) {
    return g_rffc_readback;
}

void hides_rffc2071_lo_registers(uint32_t lo_khz, uint16_t registers[3]) {
    uint32_t ratio = 5400000 / lo_khz;
    uint32_t divider_log = 0, fvco, prescaler, prescaler_code, scaled, n, fraction, msb, remainder, lsb;
    while (ratio > 1) {
        ratio >>= 1;
        divider_log++;
    }
    fvco = (1u << divider_log) * lo_khz;
    prescaler = fvco > 3200000 ? 4 : 2;
    prescaler_code = prescaler == 4 ? 2 : 1;
    scaled = fvco * 10 / prescaler / 26;
    n = fvco / prescaler / 26000;
    fraction = scaled - n * 10000;
    msb = fraction * 65536 / 10000;
    remainder = fraction * 65536 - msb * 10000;
    lsb = remainder * 256 / 10000;
    registers[0] = (uint16_t)(n << 7 | divider_log << 4 | prescaler_code << 2 | 2);
    registers[1] = (uint16_t)msb;
    registers[2] = (uint16_t)(lsb << 8);
}

static void rffc_set_lo(uint32_t lo_khz) {
    uint16_t registers[3];
    rffc_set_enabled(0);
    hides_rffc2071_lo_registers(lo_khz, registers);
    rffc_write(8, (uint16_t)((g_rffc_shadow[8] & 0x7FFE) | 0x8000));
    rffc_write(0x0F, registers[0]);
    rffc_write(0x10, registers[1]);
    rffc_write(0x11, registers[2]);
    rffc_set_enabled(1);
    BrUser_delay((Bridge *)&g_bridge, RFFC_SETTLE_MS);
}

uint32_t hides_rx_init(void) {
    uint32_t error;
    TsSource *source = &g_bridge.tsSource[0][0];

    g_bridge.it9300user_usb20_frame_size_dw = 188 * TS_PACKETS_PER_TRANSFER / 4;
    g_bridge.bypassScript = True;
    g_bridge.bypassBoot = False;
    g_bridge.gator[0].existed = True;
    g_bridge.gator[0].outDataType = OUT_DATA_TS_PARALLEL;
    g_bridge.gator[0].outTsPktLen = PKT_LEN_188;
    g_bridge.gator[0].booted = False;
    g_bridge.receiver_chip_number[0] = 1;

    // Defaults the reference driver uses for a single-bridge IT913x board.
    source->existed = True;
    source->tsType = TS_SERIAL;
    source->i2cAddr = 0x38;
    source->i2cBus = 3;
    source->tsPort = TS_PORT_1;
    if (g_info.board_id == 0x35) {
        // From the board 0x35 branch of DRV_GetEEPROMConfig in IT9300BDA.sys.
        source->i2cBus = 2;
        source->tsPort = TS_PORT_4;
    }
    source->tsPktLen = 188;
    source->syncByte = 0x47;
    source->htsDev = &g_demod;
    g_demod.userData = &g_bridge;
    g_demod.pendeavour = &g_bridge;
    g_demod.br_idx = 0;
    g_demod.tsSrcIdx = 0;

    if ((error = IT9300_initialize(&g_bridge, 0))) return error;

    if ((error = Demodulator_initialize((Demodulator *)&g_demod, (StreamType)(source->tsType + 4)))) return error;
    if ((error = IT9300_setInTsType(&g_bridge, 0, 0))) return error;
    if ((error = IT9300_setSyncByteMode(&g_bridge, 0, 0))) return error;

    if (g_info.mixer == HIDES_MIXER_ADRF6655) {
        if ((error = ADRF6655_init(&g_bridge))) return error;
        g_mixer_ready = 1;
    } else if (g_info.mixer == HIDES_MIXER_RFFC2071) {
        if ((error = rffc_init())) return error;
        g_mixer_ready = 1;
    }
    return BR_ERR_NO_ERROR;
}

uint32_t hides_rx_plan_tune(hides_mixer mixer, uint32_t lo1_khz, uint32_t lo2_khz, uint32_t rf_khz, hides_tune_plan *plan) {
    memset(plan, 0, sizeof(*plan));
    if (rf_khz <= DIRECT_MAX_KHZ) {
        plan->if_khz = rf_khz;
        return 0;
    }
    if (mixer != HIDES_MIXER_ADRF6655 && mixer != HIDES_MIXER_RFFC2071) return HIDES_ERR_UNSUPPORTED_MIXER;
    plan->use_mixer = 1;
    plan->use_lo1_path = rf_khz <= LOWER_BAND_MAX_KHZ;
    plan->lo_khz = plan->use_lo1_path ? lo1_khz : lo2_khz;
    if (plan->lo_khz == 0) return HIDES_ERR_NO_LO;
    plan->if_khz = rf_khz > plan->lo_khz ? rf_khz - plan->lo_khz : plan->lo_khz - rf_khz;
    return 0;
}

static uint32_t set_gpio(Word out, Word en, Word on, Byte value) {
    uint32_t error;
    if ((error = IT9300_writeRegister(&g_bridge, 0, out, value))) return error;
    if ((error = IT9300_writeRegister(&g_bridge, 0, en, 1))) return error;
    return IT9300_writeRegister(&g_bridge, 0, on, 1);
}

uint32_t hides_rx_tune(uint32_t rf_khz, uint16_t bandwidth_khz) {
    uint32_t error;
    hides_tune_plan plan;

    // The extra narrow-band GPIO sequence in the Windows driver runs only on ADRF6655 boards.
    if (g_info.mixer == HIDES_MIXER_ADRF6655 && bandwidth_khz < NARROW_BW_LIMIT_KHZ) return HIDES_ERR_NARROW_BW;
    error = hides_rx_plan_tune(g_info.mixer, g_info.lo1_khz, g_info.lo2_khz, rf_khz, &plan);
    if (error) return error;

    if (g_mixer_ready && g_info.mixer == HIDES_MIXER_RFFC2071) {
        if ((error = set_gpio(REG_MIXER_ENABLE_O, REG_MIXER_ENABLE_EN, REG_MIXER_ENABLE_ON, plan.use_mixer))) return error;
        if (plan.use_mixer) {
            if ((error = set_gpio(REG_BAND_O, REG_BAND_EN, REG_BAND_ON, plan.use_lo1_path))) return error;
            rffc_set_lo(plan.lo_khz);
        }
    } else if (g_mixer_ready) {
        if (plan.use_mixer) {
            if ((error = ADRF6655_setLoFrequency(&g_bridge, plan.lo_khz))) return error;
            if ((error = ADRF6655_setCpRefSource(&g_bridge, False))) return error;
            if ((error = ADRF6655_setCpCurrentMultiplier(&g_bridge, 3))) return error;
            if ((error = set_gpio(REG_MIXER_ENABLE_O, REG_MIXER_ENABLE_EN, REG_MIXER_ENABLE_ON, 1))) return error;
            if ((error = set_gpio(REG_LO_PATH_O, REG_LO_PATH_EN, REG_LO_PATH_ON, plan.use_lo1_path))) return error;
        } else {
            if ((error = set_gpio(REG_MIXER_ENABLE_O, REG_MIXER_ENABLE_EN, REG_MIXER_ENABLE_ON, 0))) return error;
        }
    }
    return Demodulator_acquireChannel((Demodulator *)&g_demod, bandwidth_khz, plan.if_khz);
}

uint32_t hides_rx_get_status(hides_rx_status *status) {
    uint32_t error;
    Statistic statistic;
    Long dbm = 0;

    memset(status, 0, sizeof(*status));
    if ((error = Demodulator_getStatistic((Demodulator *)&g_demod, &statistic))) return error;
    Demodulator_getSignalStrengthDbm((Demodulator *)&g_demod, &dbm);
    status->tps_locked = statistic.signalPresented == True;
    status->mpeg_locked = statistic.signalLocked == True;
    status->strength_percent = statistic.signalStrength;
    status->quality_percent = statistic.signalQuality;
    status->strength_dbm = (int32_t)dbm;
    if (status->tps_locked) {
        Byte snr = 0;
        Dword errors = 0, bits = 0;
        Word aborted = 0;
        if (!Demodulator_getSNR((Demodulator *)&g_demod, &snr)) status->snr_db = snr;
        // With no packets in the window the vendor code reports 1 error in 2 bits; keep that as zero.
        if (!Demodulator_getPostVitBer((Demodulator *)&g_demod, &errors, &bits, &aborted) && bits > 2) {
            status->post_viterbi_errors = errors;
            status->post_viterbi_bits = bits;
            status->uncorrected_packets = aborted;
        }
    }
    return BR_ERR_NO_ERROR;
}

uint32_t hides_rx_get_modulation(hides_rx_modulation *modulation) {
    uint32_t error;
    ChannelModulation channel;

    memset(modulation, 0, sizeof(*modulation));
    if ((error = Demodulator_getChannelModulation((Demodulator *)&g_demod, &channel))) return error;
    modulation->fft_mode = (uint8_t)channel.transmissionMode;
    modulation->constellation = (uint8_t)channel.constellation;
    modulation->guard_interval = (uint8_t)channel.interval;
    modulation->code_rate = (uint8_t)channel.highCodeRate;
    modulation->hierarchy = (uint8_t)channel.hierarchy;
    return BR_ERR_NO_ERROR;
}

uint32_t hides_rx_set_streaming(int enabled) {
    uint32_t error;
    if (enabled) return IT9300_enableTsPort(&g_bridge, 0, 0);
    if ((error = IT9300_disableTsPort(&g_bridge, 0, 0))) return error;
    BrUser_delay((Bridge *)&g_bridge, 10);
    if ((error = IT9300_writeRegister(&g_bridge, 0, p_br_reg_mp2_sw_rst, 1))) return error;
    return IT9300_writeRegister(&g_bridge, 0, p_br_reg_mp2_sw_rst, 0);
}
