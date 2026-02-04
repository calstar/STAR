#ifndef DAQ_ENCRYPTED_FRAME_HPP
#define DAQ_ENCRYPTED_FRAME_HPP

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace daq_comms {
namespace protocol {

/**
 * @brief Frame header structure for encrypted sensor packets
 *
 * This matches the embedded-side frame format specification.
 * The exact layout should be documented in docs/PROTOCOL.md
 */
struct FrameHeader {
    uint8_t magic;          // Magic byte for frame sync (e.g., 0xAA)
    uint8_t version;        // Protocol version
    uint16_t sequence_id;   // Sequence number for loss detection
    uint32_t timestamp_ms;  // Timestamp in milliseconds
    uint16_t payload_size;  // Size of encrypted payload
    uint8_t sensor_count;   // Number of sensor samples in payload
    uint8_t flags;          // Status flags
    uint32_t crc32;         // CRC32 checksum of header (excluding CRC field)

    static constexpr uint8_t MAGIC_BYTE = 0xAA;
    static constexpr uint8_t PROTOCOL_VERSION = 0x01;
    static constexpr size_t HEADER_SIZE = 16;  // Total header size in bytes
};

/**
 * @brief Decoded sensor frame containing all sensor samples
 */
struct SensorFrame {
    FrameHeader header;
    std::vector<uint8_t> decrypted_payload;  // Decrypted payload bytes

    // Metadata
    uint64_t receive_timestamp_ns;  // When frame was received (monotonic)
    std::string source_address;     // Source IP address
    uint16_t source_port;           // Source port
};

/**
 * @brief Raw sensor sample structures (before calibration)
 */
struct RawPTSample {
    uint8_t channel_id;
    uint32_t raw_adc_counts;
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
};

struct RawTCSample {
    uint8_t channel_id;
    uint32_t raw_adc_counts;
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
};

struct RawRTDSample {
    uint8_t channel_id;
    uint32_t raw_resistance_counts;  // ADC counts representing resistance
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
};

struct RawLCSample {
    uint8_t channel_id;
    uint32_t raw_adc_counts;
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
};

/**
 * @brief Decoded sensor batch from a single frame
 */
struct SensorBatch {
    uint64_t frame_timestamp_ns;
    uint16_t sequence_id;

    std::vector<RawPTSample> pt_samples;
    std::vector<RawTCSample> tc_samples;
    std::vector<RawRTDSample> rtd_samples;
    std::vector<RawLCSample> lc_samples;

    bool is_valid;
    std::string error_message;
};

/**
 * @brief Frame decoder for encrypted sensor packets
 *
 * Handles:
 * - Frame synchronization (finding magic byte)
 * - Header parsing and validation
 * - Decryption (with key management abstraction)
 * - Payload unpacking into sensor samples
 * - Sequence tracking for loss detection
 */
class FrameDecoder {
public:
    FrameDecoder();
    ~FrameDecoder() = default;

    /**
     * @brief Set decryption key (for development, use a simple key)
     * @param key Key bytes (length depends on cipher)
     * @param key_length Length of key in bytes
     */
    void set_decryption_key(const uint8_t* key, size_t key_length);

    /**
     * @brief Process raw bytes and attempt to decode a frame
     * @param data Raw bytes received from network
     * @param size Number of bytes available
     * @return Decoded frame if successful, empty otherwise
     */
    std::optional<SensorFrame> decode_frame(const uint8_t* data, size_t size);

    /**
     * @brief Unpack decrypted payload into sensor samples
     * @param frame Decoded frame with decrypted payload
     * @return Sensor batch with all samples, or empty if unpacking fails
     */
    std::optional<SensorBatch> unpack_payload(const SensorFrame& frame);

    /**
     * @brief Get statistics about decoding
     */
    struct Stats {
        size_t frames_decoded;
        size_t frames_dropped;
        size_t decryption_failures;
        size_t unpack_failures;
        uint16_t last_sequence_id;
        size_t sequence_gaps;
    };

    Stats get_stats() const {
        return stats_;
    }
    void reset_stats() {
        stats_ = Stats{};
    }

private:
    std::vector<uint8_t> decryption_key_;
    Stats stats_;
    uint16_t expected_sequence_id_;

    bool validate_header(const FrameHeader& header) const;
    bool decrypt_payload(const uint8_t* encrypted, size_t encrypted_size,
                         std::vector<uint8_t>& decrypted) const;
    uint32_t compute_crc32(const uint8_t* data, size_t size) const;

    // Simple XOR cipher for development (replace with real encryption)
    void simple_xor_decrypt(const uint8_t* input, uint8_t* output, size_t size) const;
};

}  // namespace protocol
}  // namespace daq_comms

#endif  // DAQ_ENCRYPTED_FRAME_HPP
