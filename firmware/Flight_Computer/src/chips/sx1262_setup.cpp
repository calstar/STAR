#include "sx1262_setup.h"

#include <string.h>

namespace radio_link {
namespace {

// Opcodes (Rev 1.2 command table, p.62-64).
constexpr uint8_t kOpSetStandby = 0x80;
constexpr uint8_t kOpSetRegulatorMode = 0x96;
constexpr uint8_t kOpSetDio3AsTcxoCtrl = 0x97;
constexpr uint8_t kOpCalibrate = 0x89;
constexpr uint8_t kOpCalibrateImage = 0x98;
constexpr uint8_t kOpClearDeviceErrors = 0x07;
constexpr uint8_t kOpGetDeviceErrors = 0x17;
constexpr uint8_t kOpSetDio2AsRfSwitch = 0x9D;
constexpr uint8_t kOpSetPacketType = 0x8A;
constexpr uint8_t kOpSetRfFrequency = 0x86;
constexpr uint8_t kOpSetPaConfig = 0x95;
constexpr uint8_t kOpSetTxParams = 0x8E;
constexpr uint8_t kOpSetBufferBase = 0x8F;
constexpr uint8_t kOpSetModulation = 0x8B;
constexpr uint8_t kOpSetPacketParams = 0x8C;
constexpr uint8_t kOpSetDioIrqParams = 0x08;
constexpr uint8_t kOpWriteRegister = 0x0D;
constexpr uint8_t kOpReadRegister = 0x1D;
constexpr uint8_t kOpWriteBuffer = 0x0E;
constexpr uint8_t kOpSetTx = 0x83;

constexpr uint16_t kIrqTxDone = 1u << 0;  // Table 13-29, p.80
constexpr uint16_t kIrqTimeout = 1u << 9;
// DIO1 carries everything the board waits on: TX done/timeout, RX done and
// the two receive errors Ryan's receive() counts.
constexpr uint16_t kIrqMask =
    kIrqTxDone | kIrqRxDone | kIrqHeaderErr | kIrqCrcErr | kIrqTimeout;

constexpr uint16_t kRegTxModulation = 0x0889;  // p.66, errata 15.1 (p.102)
constexpr uint16_t kRegTxClamp = 0x08D8;       // p.66, errata 15.2 (p.103)
constexpr uint16_t kRegSyncWord = 0x0740;      // p.65

// SetDIO3AsTCXOCtrl: 1.8 V (Table 13-35, p.82; the Seeed XIAO kits' value,
// and >= 200 mV under the module's 3.3 V), 5 ms to settle in 15.625 us steps.
constexpr uint8_t kTcxo1V8 = 0x02;
constexpr uint32_t kTcxoDelaySteps = 320;

constexpr uint8_t kRamp200us = 0x04;  // Table 13-41, p.84

// LoRa symbol time 2^SF / BW in us, for the BW codes this driver allows
// (Table 13-48, p.87): 125, 250, 500 kHz.
uint32_t symbol_us(const LoraConfig& cfg) {
    uint32_t bw_hz = 125000;
    if (cfg.bw == 0x05) {
        bw_hz = 250000;
    } else if (cfg.bw == 0x06) {
        bw_hz = 500000;
    }
    return (1000000u << cfg.sf) / bw_hz;
}

// Low Data Rate Optimization when a symbol lasts >= 16.38 ms (6.1.1.4, p.39).
bool use_ldro(const LoraConfig& cfg) {
    return symbol_us(cfg) >= 16380;
}

}  // namespace

uint32_t sx1262_frequency_word(uint32_t freq_hz) {
    return static_cast<uint32_t>((static_cast<uint64_t>(freq_hz) << 25) /
                                 32000000u);
}

uint32_t lora_time_on_air_us(const LoraConfig& cfg, uint8_t payload_len) {
    const int sf = cfg.sf;
    const uint32_t tsym_us = symbol_us(cfg);
    const bool ldro = use_ldro(cfg);
    // Nsymbol, quarter-symbol units to keep the 4.25 exact (p.41).
    int num = 8 * payload_len + 16 - 4 * sf + 8 + 20;  // CRC on, explicit
    if (num < 0) {
        num = 0;
    }
    const int den = 4 * (ldro ? sf - 2 : sf);
    const int blocks = (num + den - 1) / den;
    const uint32_t quarters = static_cast<uint32_t>(4 * cfg.preamble + 17 + 32 +
                                                    4 * blocks * (cfg.cr + 4));
    return quarters * tsym_us / 4;
}

bool Sx1262Setup::cmd(const uint8_t* tx, uint16_t n) {
    if (!bus_.wait_busy()) {
        return false;
    }
    bus_.transfer(tx, rx_, n);
    return true;
}

bool Sx1262Setup::read_register(uint16_t addr, uint8_t& value) {
    // ReadRegister: opcode, addr hi, addr lo, NOP, then data (p.78).
    const uint8_t tx[5] = {kOpReadRegister, static_cast<uint8_t>(addr >> 8),
                           static_cast<uint8_t>(addr), 0, 0};
    if (!cmd(tx, sizeof tx) || !sx1262_status_ok(rx_[1])) {
        return false;
    }
    value = rx_[4];
    return true;
}

bool Sx1262Setup::write_register(uint16_t addr, const uint8_t* data,
                                 uint8_t n) {
    uint8_t tx[3 + 4];
    if (n > 4) {
        return false;
    }
    tx[0] = kOpWriteRegister;
    tx[1] = static_cast<uint8_t>(addr >> 8);
    tx[2] = static_cast<uint8_t>(addr);
    memcpy(tx + 3, data, n);
    return cmd(tx, static_cast<uint16_t>(3 + n));
}

bool Sx1262Setup::set_packet_params(uint8_t payload_len) {
    // LoRa: preamble, explicit header, payload length (max in RX), CRC on,
    // standard IQ (Tables 13-66..13-70, p.91-92).
    const uint8_t tx[7] = {kOpSetPacketParams,
                           static_cast<uint8_t>(cfg_.preamble >> 8),
                           static_cast<uint8_t>(cfg_.preamble),
                           0x00,
                           payload_len,
                           0x01,
                           0x00};
    return cmd(tx, sizeof tx);
}

bool Sx1262Setup::irq_status(uint16_t& irq) {
    const uint8_t tx[4] = {kOpGetIrqStatus, 0, 0, 0};
    if (!cmd(tx, sizeof tx) || !sx1262_status_ok(rx_[1])) {
        return false;
    }
    irq = static_cast<uint16_t>((rx_[2] << 8) | rx_[3]);
    return true;
}

bool Sx1262Setup::back_to_rx() {
    control_.set_rx_switch(true);
    const uint8_t rx_mode[4] = {kOpSetRx, 0xFF, 0xFF, 0xFF};  // continuous
    return set_packet_params(0xFF) && cmd(rx_mode, sizeof rx_mode);
}

SetupStep Sx1262Setup::configure() {
    control_.set_rx_switch(false);
    const uint8_t standby[2] = {kOpSetStandby, 0x00};  // STDBY_RC
    if (!cmd(standby, sizeof standby)) {
        return SetupStep::Standby;
    }
    const uint8_t regulator[2] = {kOpSetRegulatorMode, 0x01};  // DC-DC, p.74
    if (!cmd(regulator, sizeof regulator)) {
        return SetupStep::Regulator;
    }
    const uint8_t tcxo[5] = {kOpSetDio3AsTcxoCtrl, kTcxo1V8,
                             static_cast<uint8_t>(kTcxoDelaySteps >> 16),
                             static_cast<uint8_t>(kTcxoDelaySteps >> 8),
                             static_cast<uint8_t>(kTcxoDelaySteps)};
    if (!cmd(tcxo, sizeof tcxo)) {
        return SetupStep::Tcxo;
    }
    // The power-on calibration ran before the chip knew about the TCXO and
    // fails; recalibrate everything (p.57), then clear the expected
    // XOSC_START_ERR (p.82). BUSY stays high up to 3.5 ms (p.75).
    const uint8_t calibrate[2] = {kOpCalibrate, 0x7F};
    const uint8_t clear_errors[3] = {kOpClearDeviceErrors, 0, 0};
    if (!cmd(calibrate, sizeof calibrate) ||
        !cmd(clear_errors, sizeof clear_errors)) {
        return SetupStep::Calibrate;
    }
    const uint8_t rf_switch[2] = {kOpSetDio2AsRfSwitch, 0x01};  // p.81
    if (!cmd(rf_switch, sizeof rf_switch)) {
        return SetupStep::RfSwitch;
    }
    const uint8_t packet_type[2] = {kOpSetPacketType, 0x01};  // LoRa, p.83
    if (!cmd(packet_type, sizeof packet_type)) {
        return SetupStep::PacketType;
    }
    const uint32_t f = sx1262_frequency_word(cfg_.freq_hz);
    const uint8_t freq[5] = {kOpSetRfFrequency, static_cast<uint8_t>(f >> 24),
                             static_cast<uint8_t>(f >> 16),
                             static_cast<uint8_t>(f >> 8),
                             static_cast<uint8_t>(f)};
    if (!cmd(freq, sizeof freq)) {
        return SetupStep::Frequency;
    }
    const uint8_t image[3] = {kOpCalibrateImage, 0xE1, 0xE9};  // 902-928, p.57
    if (!cmd(image, sizeof image)) {
        return SetupStep::ImageCalibration;
    }
    // +22 dBm optimal setting (Table 13-21, p.77); paDutyCycle <= 0x04 and
    // hpMax <= 0x07 are the SX1262's limits (p.76-77).
    const uint8_t pa[5] = {kOpSetPaConfig, 0x04, 0x07, 0x00, 0x01};
    if (!cmd(pa, sizeof pa)) {
        return SetupStep::PaConfig;
    }
    const uint8_t tx_params[3] = {
        kOpSetTxParams, static_cast<uint8_t>(cfg_.power_dbm), kRamp200us};
    if (!cmd(tx_params, sizeof tx_params)) {
        return SetupStep::TxParams;
    }
    const uint8_t base[3] = {kOpSetBufferBase, 0x00, 0x00};  // p.93
    if (!cmd(base, sizeof base)) {
        return SetupStep::BufferBase;
    }
    const uint8_t modulation[5] = {
        kOpSetModulation, cfg_.sf, cfg_.bw, cfg_.cr,
        static_cast<uint8_t>(use_ldro(cfg_) ? 1 : 0)};
    if (!cmd(modulation, sizeof modulation)) {
        return SetupStep::Modulation;
    }
    if (!set_packet_params(0xFF)) {
        return SetupStep::PacketParams;
    }
    const uint8_t irq[9] = {kOpSetDioIrqParams,
                            static_cast<uint8_t>(kIrqMask >> 8),
                            static_cast<uint8_t>(kIrqMask),
                            static_cast<uint8_t>(kIrqMask >> 8),
                            static_cast<uint8_t>(kIrqMask),
                            0,
                            0,
                            0,
                            0};  // all on DIO1 (p.79)
    if (!cmd(irq, sizeof irq)) {
        return SetupStep::IrqMap;
    }
    // Errata 15.2: TxClampConfig bits 4:1 = 1111 after power-on (p.103).
    uint8_t clamp = 0;
    if (!read_register(kRegTxClamp, clamp)) {
        return SetupStep::TxClamp;
    }
    clamp = static_cast<uint8_t>(clamp | 0x1E);
    if (!write_register(kRegTxClamp, &clamp, 1)) {
        return SetupStep::TxClamp;
    }
    const uint8_t sync[2] = {static_cast<uint8_t>(cfg_.sync_word >> 8),
                             static_cast<uint8_t>(cfg_.sync_word)};
    if (!write_register(kRegSyncWord, sync, 2)) {
        return SetupStep::SyncWord;
    }
    const uint8_t errors[4] = {kOpGetDeviceErrors, 0, 0, 0};
    if (!cmd(errors, sizeof errors) || !sx1262_status_ok(rx_[1])) {
        return SetupStep::DeviceErrors;
    }
    device_errors_ = static_cast<uint16_t>((rx_[2] << 8) | rx_[3]);
    if (device_errors_ != 0) {
        return SetupStep::DeviceErrors;
    }
    return back_to_rx() ? SetupStep::Ok : SetupStep::StartRx;
}

RadioStatus Sx1262Setup::send(const uint8_t* bytes, uint8_t len) {
    if (bytes == nullptr || len == 0) {
        return RadioStatus::ErrTooLong;  // radio.h: 1..255 bytes
    }
    const uint8_t standby[2] = {kOpSetStandby, 0x00};
    if (!cmd(standby, sizeof standby)) {
        return RadioStatus::ErrNotFound;
    }
    control_.set_rx_switch(false);

    // Errata 15.1 (p.102): TxModulation bit 2 = 1 unless BW is 500 kHz.
    uint8_t mod = 0;
    if (!read_register(kRegTxModulation, mod)) {
        back_to_rx();
        return RadioStatus::ErrNotFound;
    }
    mod = cfg_.bw == 0x06 ? static_cast<uint8_t>(mod & ~0x04)
                          : static_cast<uint8_t>(mod | 0x04);
    tx_[0] = kOpWriteBuffer;
    tx_[1] = 0x00;  // TX base address
    memcpy(tx_ + 2, bytes, len);
    // Clear only the TX flags: a packet that arrived just now (RxDone) must
    // survive the send so the next receive() still sees it.
    const uint8_t clear[3] = {
        kOpClearIrqStatus,
        static_cast<uint8_t>((kIrqTxDone | kIrqTimeout) >> 8),
        static_cast<uint8_t>(kIrqTxDone | kIrqTimeout)};
    // Chip timeout: twice the time on air, in 15.625 us steps (p.69).
    const uint32_t toa_us = lora_time_on_air_us(cfg_, len);
    const uint32_t steps = (2u * toa_us * 64u + 999u) / 1000u;
    const uint8_t set_tx[4] = {kOpSetTx, static_cast<uint8_t>(steps >> 16),
                               static_cast<uint8_t>(steps >> 8),
                               static_cast<uint8_t>(steps)};
    if (!write_register(kRegTxModulation, &mod, 1) || !set_packet_params(len) ||
        !cmd(tx_, static_cast<uint16_t>(2 + len)) ||
        !cmd(clear, sizeof clear) || !cmd(set_tx, sizeof set_tx)) {
        back_to_rx();
        return RadioStatus::ErrNotFound;
    }

    // Wait for TxDone or the chip's Timeout; the host gives up 50 ms after
    // the chip should have, in case the chip itself is stuck.
    const uint32_t limit_ms = 2u * toa_us / 1000u + 50u;
    RadioStatus result = RadioStatus::ErrTimeout;
    for (uint32_t waited = 0;; ++waited) {
        uint16_t irq = 0;
        if (!irq_status(irq)) {
            result = RadioStatus::ErrNotFound;
            break;
        }
        if (irq & kIrqTxDone) {
            result = RadioStatus::Ok;
            break;
        }
        if (irq & kIrqTimeout) {
            break;
        }
        if (waited == limit_ms) {
            break;  // waited the limit and checked once more
        }
        control_.delay_ms(1);
    }
    cmd(clear, sizeof clear);
    if (result == RadioStatus::Ok) {
        tx_ok_++;
    } else if (result == RadioStatus::ErrTimeout) {
        tx_timeouts_++;
    }
    if (!back_to_rx() && result == RadioStatus::Ok) {
        result = RadioStatus::ErrNotFound;
    }
    return result;
}

}  // namespace radio_link
