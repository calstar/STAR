#include "board_pins.h"
#include "adcs.h"
#include "EthernetHandler.h"


// 1 = ASCII voltages for the Python calibration script
// 0 = binary sweep packets
#define TEXT_OUTPUT 0
#define PT_NUM_START 0
#define NUM_PTS 10


static inline void flushPacketIfNeeded(bool force);
static void sendSweepIfNeeded(const adcs::AllResults& sweep);

// Sentinals

static constexpr uint8_t  PAD_CH   = 0xFF;         // "no channel"
static constexpr int32_t  SENT_I32 = INT32_MIN;    // "missing" for signed 32
static constexpr uint32_t SENT_U32 = 0xFFFFFFFFu;  // "missing" for unsigned 32

// --- Buffer settings ---
static const size_t PKT_MAX = 1024;   // packet size in bytes

static uint8_t pktA[PKT_MAX];
static uint8_t pktB[PKT_MAX];
static uint8_t* active = pktA;
static uint8_t* standby = pktB;

static const uint32_t FLUSH_MS = 10;  // flush every ~10 ms
static size_t used = 0;
static uint32_t lastFlushMs = 0;

// ===== Sweep packet format =====
// Little endian

#pragma pack(push,1)
struct PacketHeader {
  char     magic[4];        // "AD26"
  uint8_t  version;         // 2 (new format)
  uint8_t  flags;           // bit0 = per-record t_us present
  uint16_t count;           // number of records in this sweep
  uint16_t failures;        // from readAll
  uint32_t total_time_us;   // total sweep time
  uint32_t packet_time_us;  // FULL micros() when this packet is sent
};


struct Rec18 {
  uint8_t  ch;              // channel id
  uint8_t  ok;              // 0 or 1
  int32_t  raw;
  int32_t sample_time;             // ADC code
  uint32_t read_time_dur;    // per read()
  uint32_t conv_time_dur;    // wait for DRDY
};
#pragma pack(pop)

// ===== CRC32 (poly 0xEDB88320, init 0xFFFFFFFF, final XOR 0xFFFFFFFF) =====
static uint32_t crc32_le(const uint8_t* data, size_t len) {
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < len; ++i) {
    crc ^= data[i];
    for (int k = 0; k < 8; ++k) {
      uint32_t mask = -(crc & 1u);
      crc = (crc >> 1) ^ (0xEDB88320u & mask);
      
    }
  }
  
  return crc ^ 0xFFFFFFFFu;
}


static void sendSweepPacket(const adcs::AllResults& sweep) {
  uint32_t packet_time = micros();

  const size_t header_sz = sizeof(PacketHeader);
  const size_t rec_sz    = sizeof(Rec18);
  const size_t n_fixed   = 10;
  const size_t payload_no_crc = header_sz + n_fixed * rec_sz;
  const size_t total_len      = payload_no_crc + sizeof(uint32_t);

  if (total_len > PKT_MAX) {
    // With n_fixed=10 this should not happen.
    return;
  }

  // Build packet into the small scratch buffer (reuse your existing “active”)
  uint8_t* buf = standby; // use standby as a scratch area so we don't disturb "active"
  size_t off = 0;

  PacketHeader h;
  memcpy(h.magic, "AD26", 4);
  h.version        = 2;
  h.flags          = 0x01;
  h.count          = n_fixed;
  h.failures       = sweep.failures + static_cast<uint16_t>((n_fixed > sweep.count) ? (n_fixed - sweep.count) : 0);
  h.total_time_us  = sweep.total_time;
  h.packet_time_us = packet_time;
  memcpy(buf + off, &h, sizeof(h)); off += sizeof(h);

  const size_t n_real = (sweep.count <= n_fixed) ? sweep.count : n_fixed;
  for (size_t i = 0; i < n_real; ++i) {
    const auto& s = sweep.samples[i];
    Rec18 r;
    r.ch            = s.channel;
    r.ok            = s.result.ok ? 1u : 0u;
    r.raw           = s.result.raw;
    r.sample_time   = s.result.sample_time;
    r.read_time_dur = s.result.read_time_dur;
    r.conv_time_dur = s.result.conv_time_dur;
    memcpy(buf + off, &r, sizeof(r)); off += sizeof(r);
  }

  for (size_t i = n_real; i < n_fixed; ++i) {
    Rec18 r;
    r.ch            = PAD_CH;
    r.ok            = 0;
    r.raw           = SENT_I32;
    r.sample_time   = SENT_I32;
    r.read_time_dur = SENT_U32;
    r.conv_time_dur = SENT_U32;
    memcpy(buf + off, &r, sizeof(r)); off += sizeof(r);
  }

  const uint32_t crc = crc32_le(buf, off);
  memcpy(buf + off, &crc, sizeof(crc)); off += sizeof(crc);

  // Append the completed sweep packet into the large outgoing buffer.
  // If it won’t fit, flush first, then append.
  if (used + off > PKT_MAX) {
    flushPacketIfNeeded(true);
  }
  memcpy(active + used, buf, off);
  used += off;

  // Do not Serial.write here. Let the timed flush handle it.
}


void setup() {
  Serial.begin(115200);
  SPI.begin(SCLK, MISOp, MOSIp, CS);

  EthernetConfig ethConfig{};
  ethConfig.pins = {7, 41, 13, 6};
  ethConfig.staticIP = IPAddress(192, 168, 2, 102);
  ethConfig.gateway = IPAddress(192, 168, 2, 1);
  ethConfig.subnet = IPAddress(255, 255, 255, 0);
  ethConfig.dns = IPAddress(192, 168, 2, 1);
  ethConfig.receiverIP = IPAddress(192, 168, 2, 1);
  ethConfig.receiverPort = 5006;
  ethConfig.localPort = 5005;
  EthernetInit(ethConfig);
  Serial.print("DAQ Ethernet IP: ");
  Serial.println(getLocalIP());

  if (!adcs::init())    { while (1) { delay(1000); } }
  if (!adcs::configure()){ while (1) { delay(1000); } }
}

void loop() {
  // One sweep
  adcs::AllResults sweep = adcs::readAll(channels, num_channels);

  // if (TEXT_OUTPUT) {
  //   // ASCII volts for calibration scripts
  //   for (size_t i = 0; i < sweep.count; ++i) {
  //     const auto& s = sweep.samples[i];
  //     float volts = (float)s.result.raw * vRef / adcScale;
  //     Serial.print(volts, 6);
  //     if (i + 1 < sweep.count) Serial.print(' ');
  //   }
  //   Serial.print("\r\n");
  // } else {
    sendSweepPacket(sweep);
    flushPacketIfNeeded(false);  // flush by time
  // }
}


static inline void flushPacketIfNeeded(bool force = false) {
  uint32_t now = millis();
  if (force || (used > 0 && (now - lastFlushMs >= FLUSH_MS))) {
    if (ethernetReady()) {
      sendPacket(active, used);
    }
    Serial.write(active, used);
    // optional delimiter: Serial.println();
    uint8_t* tmp = active; active = standby; standby = tmp;
    used = 0;
    lastFlushMs = now;
  }
}
