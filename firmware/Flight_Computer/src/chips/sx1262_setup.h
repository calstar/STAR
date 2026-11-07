#ifndef SX1262_SETUP_H
#define SX1262_SETUP_H

// SX1262 start-up and transmit, layered on Ryan's SpiBus / Sx1262 (receive).
// Datasheet: Semtech DS_SX1261-2 Rev 1.2 (June 2019). Module: Seeed
// Wio-SX1262 V1.1 (DC-DC, TCXO on DIO3, RF switch on DIO2 + RF_SW).
//
// Start-up order follows 14.2 / 14.4 (p.99-100): standby, regulator, TCXO,
// calibrate, then packet type first, modulation, packet params. After it the
// chip listens in continuous RX (Ryan's requirement, README): send() returns
// it there after every packet.

#include <stdint.h>

#include "radio.h"
#include "sx1262.h"

namespace radio_link {

// What the board does around the chip: the module's RF_SW pin and waiting.
class RadioControl {
public:
    // RF_SW (PB1): true while receiving, false while transmitting or idle.
    // Meshtastic's Seeed XIAO + Wio-SX1262 variants drive this pin as RXEN;
    // DIO2 drives the TX side (Wio datasheet p.5 note 1). Verify on bench.
    virtual void set_rx_switch(bool receive) = 0;
    virtual void delay_ms(uint32_t ms) = 0;

protected:
    ~RadioControl() {
    }
};

// Link settings. Every value except the hardware ones (TCXO, regulator, PA
// table) is a proposal for the lead (README "Decisions"); the ground station
// must use the same frequency, SF, BW, CR, sync word and CRC.
struct LoraConfig {
    uint32_t freq_hz;    // 915 MHz: in the Wio's 862-930 MHz band
    uint8_t sf;          // 7..12 (p.87)
    uint8_t bw;          // LORA_BW code (Table 13-48, p.87): 0x04 = 125 kHz
    uint8_t cr;          // 1..4 = 4/5..4/8 (Table 13-49)
    uint16_t preamble;   // symbols
    int8_t power_dbm;    // -9..+22 on the high-power PA (p.84)
    uint16_t sync_word;  // 0x1424 private network (reg 0x0740, p.65)
};

constexpr LoraConfig kDefaultLora = {915000000u, 9, 0x04, 1, 8, 22, 0x1424};

// Steps of configure(); its return value names the first one that failed.
enum class SetupStep : uint8_t {
    Ok = 0,
    Standby,
    Regulator,
    Tcxo,
    Calibrate,
    RfSwitch,
    PacketType,
    Frequency,
    ImageCalibration,
    PaConfig,
    TxParams,
    BufferBase,
    Modulation,
    PacketParams,
    IrqMap,
    TxClamp,
    SyncWord,
    DeviceErrors,  // GetDeviceErrors non-zero after start-up (p.98)
    StartRx,
};

enum class RxMode : uint8_t {
    Continuous,  // SetRx 0xFFFFFF: chip stays in RX until commanded otherwise
    DutyCycle,   // SetRxDutyCycle: chip sniffs then sleeps, loops autonomously
};

class Sx1262Setup {
public:
    Sx1262Setup(SpiBus& bus, RadioControl& control, const LoraConfig& cfg)
        : bus_(bus), control_(control), cfg_(cfg) {
    }

    // Full start-up from power-on (chip out of reset, BUSY low). Leaves the
    // chip in continuous RX with RF_SW set for receive.
    SetupStep configure();

    // Ryan's radio_send() contract: Ok only after TxDone; ErrTimeout if
    // neither TxDone nor the chip's own Timeout came in time; ErrNotFound
    // if the chip stops answering. Always returns the chip to whichever RX
    // mode was last set (continuous or duty cycle).
    RadioStatus send(const uint8_t* bytes, uint8_t len);

    // Switch to sniff mode (DS 13.1.7, p.71): listen rx_ms, sleep sleep_ms,
    // repeat. Must be called from STDBY_RC or any RX mode. Returns false if
    // the chip doesn't respond. send() returns here after every TX.
    bool start_rx_duty_cycle(uint32_t rx_ms, uint32_t sleep_ms);

    // Switch back to continuous RX (SetRx 0xFFFFFF). Stops the duty cycle.
    bool start_rx_continuous();

    // Re-arm after every RxDone in sniff mode: the chip returns to STDBY_RC
    // after a packet (p.71) and must be restarted or it goes deaf. No-op in
    // continuous mode (chip stays in RX on its own).
    bool rearm_rx();

    // OpError bits from the last configure() (Table 13-85, p.98).
    uint16_t device_errors() const {
        return device_errors_;
    }
    uint32_t tx_ok() const {
        return tx_ok_;
    }
    uint32_t tx_timeouts() const {
        return tx_timeouts_;
    }

private:
    bool cmd(const uint8_t* tx, uint16_t n);
    bool read_register(uint16_t addr, uint8_t& value);
    bool write_register(uint16_t addr, const uint8_t* data, uint8_t n);
    bool set_packet_params(uint8_t payload_len);
    bool irq_status(uint16_t& irq);
    bool back_to_rx();
    bool send_duty_cycle();

    SpiBus& bus_;
    RadioControl& control_;
    LoraConfig cfg_;
    RxMode rx_mode_ = RxMode::Continuous;
    uint32_t duty_rx_steps_ = 0;     // rxPeriod in 15.625 µs steps
    uint32_t duty_sleep_steps_ = 0;  // sleepPeriod in 15.625 µs steps
    uint16_t device_errors_ = 0;
    uint32_t tx_ok_ = 0;
    uint32_t tx_timeouts_ = 0;
    uint8_t tx_[2 + 255];  // WriteBuffer: opcode + offset + payload
    uint8_t rx_[2 + 255];
};

// LoRa time on air in microseconds, SF7..12 (6.1.4, p.41), explicit
// header, CRC on, as configure() sets it.
uint32_t lora_time_on_air_us(const LoraConfig& cfg, uint8_t payload_len);

// SetRfFrequency word: freq x 2^25 / 32 MHz (p.83).
uint32_t sx1262_frequency_word(uint32_t freq_hz);

}  // namespace radio_link

#endif  // SX1262_SETUP_H
