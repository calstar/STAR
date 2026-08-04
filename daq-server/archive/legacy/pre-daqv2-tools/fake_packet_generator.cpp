/**
 * @file fake_packet_generator.cpp
 * @brief Fake packet generator for testing DAQ bridge
 *
 * Generates encrypted sensor packets matching the protocol specification
 * and sends them over UDP to test the DAQ bridge pipeline.
 */

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <random>
#include <thread>
#include <vector>

namespace {

// Protocol constants
constexpr uint8_t MAGIC_BYTE = 0xAA;
constexpr uint8_t PROTOCOL_VERSION = 0x01;
constexpr size_t HEADER_SIZE = 16;

// Simple XOR encryption key (matches decoder default)
constexpr uint8_t ENCRYPTION_KEY[16] = {0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
                                        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10};

struct FrameHeader {
    uint8_t magic;
    uint8_t version;
    uint16_t sequence_id;
    uint32_t timestamp_ms;
    uint16_t payload_size;
    uint8_t sensor_count;
    uint8_t flags;
    uint32_t crc32;
} __attribute__((packed));

// Note: sensor_type is written separately, not part of sample struct
struct RawPTSample {
    uint8_t channel_id;
    uint32_t raw_adc_counts;
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
} __attribute__((packed));

struct RawTCSample {
    uint8_t channel_id;
    uint32_t raw_adc_counts;
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
} __attribute__((packed));

struct RawRTDSample {
    uint8_t channel_id;
    uint32_t raw_resistance_counts;
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
} __attribute__((packed));

struct RawLCSample {
    uint8_t channel_id;
    uint32_t raw_adc_counts;
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
} __attribute__((packed));

void xor_encrypt(const uint8_t* input, uint8_t* output, size_t size) {
    for (size_t i = 0; i < size; ++i) {
        output[i] = input[i] ^ ENCRYPTION_KEY[i % 16];
    }
}

uint32_t compute_crc32(const uint8_t* data, size_t size) {
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < size; ++i) {
        crc ^= data[i];
        for (int j = 0; j < 8; ++j) {
            crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1));
        }
    }
    return ~crc;
}

uint32_t get_timestamp_ms() {
    auto now = std::chrono::system_clock::now();
    auto duration = now.time_since_epoch();
    return std::chrono::duration_cast<std::chrono::milliseconds>(duration).count();
}

std::vector<uint8_t> create_sensor_frame(uint16_t sequence_id,
                                         const std::vector<uint8_t>& sensor_samples) {
    std::vector<uint8_t> frame;

    // Create header
    FrameHeader header = {};
    header.magic = MAGIC_BYTE;
    header.version = PROTOCOL_VERSION;
    header.sequence_id = htons(sequence_id);
    header.timestamp_ms = htonl(get_timestamp_ms());
    header.payload_size = htons(sensor_samples.size());
    // Count sensor samples (each starts with sensor_type byte, then 9 bytes of data)
    header.sensor_count = 0;
    for (size_t i = 0; i < sensor_samples.size();) {
        if (i + 1 < sensor_samples.size() &&
            (sensor_samples[i] >= 0x01 && sensor_samples[i] <= 0x04)) {
            header.sensor_count++;
            i += 10;  // sensor_type(1) + sample_data(9)
        } else {
            break;
        }
    }
    header.flags = 0;

    // Compute CRC (excluding CRC field itself)
    header.crc32 = compute_crc32(reinterpret_cast<const uint8_t*>(&header), 12);
    header.crc32 = htonl(header.crc32);

    // Encrypt payload
    std::vector<uint8_t> encrypted_payload(sensor_samples.size());
    xor_encrypt(sensor_samples.data(), encrypted_payload.data(), sensor_samples.size());

    // Build frame
    frame.resize(HEADER_SIZE + encrypted_payload.size());
    std::memcpy(frame.data(), &header, HEADER_SIZE);
    std::memcpy(frame.data() + HEADER_SIZE, encrypted_payload.data(), encrypted_payload.size());

    return frame;
}

struct UDPSender {
    int sock;
    struct sockaddr_in dest_addr;

    UDPSender(const std::string& host, uint16_t port) : sock(-1) {
        sock = socket(AF_INET, SOCK_DGRAM, 0);
        if (sock < 0) {
            std::cerr << "Failed to create socket: " << strerror(errno) << std::endl;
            return;
        }

        dest_addr = {};
        dest_addr.sin_family = AF_INET;
        dest_addr.sin_port = htons(port);
        if (inet_aton(host.c_str(), &dest_addr.sin_addr) == 0) {
            std::cerr << "Invalid address: " << host << std::endl;
            close(sock);
            sock = -1;
        }
    }

    ~UDPSender() {
        if (sock >= 0) {
            close(sock);
        }
    }

    ssize_t send(const uint8_t* data, size_t size) {
        if (sock < 0)
            return -1;
        return sendto(sock, data, size, 0, reinterpret_cast<struct sockaddr*>(&dest_addr),
                      sizeof(dest_addr));
    }

    bool is_valid() const {
        return sock >= 0;
    }
};

}  // anonymous namespace

int main(int argc, char* argv[]) {
    std::string host = "127.0.0.1";
    uint16_t port = 8888;
    double rate_hz = 10.0;  // Default 10 Hz

    if (argc > 1) {
        host = argv[1];
    }
    if (argc > 2) {
        port = static_cast<uint16_t>(std::stoi(argv[2]));
    }
    if (argc > 3) {
        rate_hz = std::stod(argv[3]);
    }

    std::cout << "Fake Packet Generator" << std::endl;
    std::cout << "Target: " << host << ":" << port << std::endl;
    std::cout << "Rate: " << rate_hz << " Hz" << std::endl;
    std::cout << "Press Ctrl+C to stop" << std::endl;

    UDPSender sender(host, port);
    if (!sender.is_valid()) {
        return 1;
    }

    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<uint32_t> adc_dist(0, 4095);
    std::uniform_int_distribution<uint32_t> resistance_dist(9000, 11000);  // RTD resistance counts

    uint16_t sequence_id = 0;
    auto interval = std::chrono::microseconds(static_cast<int>(1000000.0 / rate_hz));

    while (true) {
        // Create a frame with mixed sensor types
        std::vector<uint8_t> sensor_samples;

        // Add PT samples (channels 0-2)
        for (uint8_t ch = 0; ch < 3; ++ch) {
            sensor_samples.push_back(0x01);  // sensor_type
            RawPTSample pt = {};
            pt.channel_id = ch;
            pt.raw_adc_counts = htonl(adc_dist(gen));
            pt.sample_timestamp_ms = htonl(get_timestamp_ms());
            pt.status_flags = 0;
            sensor_samples.insert(sensor_samples.end(), reinterpret_cast<uint8_t*>(&pt),
                                  reinterpret_cast<uint8_t*>(&pt) + sizeof(pt));
        }

        // Add TC sample (channel 0)
        sensor_samples.push_back(0x02);  // sensor_type
        RawTCSample tc = {};
        tc.channel_id = 0;
        tc.raw_adc_counts = htonl(adc_dist(gen));
        tc.sample_timestamp_ms = htonl(get_timestamp_ms());
        tc.status_flags = 0;
        sensor_samples.insert(sensor_samples.end(), reinterpret_cast<uint8_t*>(&tc),
                              reinterpret_cast<uint8_t*>(&tc) + sizeof(tc));

        // Add RTD sample (channel 0)
        sensor_samples.push_back(0x03);  // sensor_type
        RawRTDSample rtd = {};
        rtd.channel_id = 0;
        rtd.raw_resistance_counts = htonl(resistance_dist(gen));
        rtd.sample_timestamp_ms = htonl(get_timestamp_ms());
        rtd.status_flags = 0;
        sensor_samples.insert(sensor_samples.end(), reinterpret_cast<uint8_t*>(&rtd),
                              reinterpret_cast<uint8_t*>(&rtd) + sizeof(rtd));

        // Add LC sample (channel 0)
        sensor_samples.push_back(0x04);  // sensor_type
        RawLCSample lc = {};
        lc.channel_id = 0;
        lc.raw_adc_counts = htonl(adc_dist(gen));
        lc.sample_timestamp_ms = htonl(get_timestamp_ms());
        lc.status_flags = 0;
        sensor_samples.insert(sensor_samples.end(), reinterpret_cast<uint8_t*>(&lc),
                              reinterpret_cast<uint8_t*>(&lc) + sizeof(lc));

        // Create and send frame
        auto frame = create_sensor_frame(sequence_id++, sensor_samples);
        ssize_t sent = sender.send(frame.data(), frame.size());

        if (sent < 0) {
            std::cerr << "Send error: " << strerror(errno) << std::endl;
            break;
        }

        if (sequence_id % 100 == 0) {
            std::cout << "Sent " << sequence_id << " frames" << std::endl;
        }

        std::this_thread::sleep_for(interval);
    }

    return 0;
}
