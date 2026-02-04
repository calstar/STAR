/**
 * @file fake_esp32_packet_gen.cpp
 * @brief Fake ESP32 packet generator for testing
 *
 * Generates realistic ESP32 packets in Rec18 format and sends them to a named pipe
 * or file descriptor to simulate the real ESP32 hardware
 */

#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <random>
#include <thread>
#include <vector>

// ESP32 Packet structures - EXACTLY matching Arduino code
#pragma pack(push, 1)
struct ESP32PacketHeader {
    char magic[4];            // "AD26"
    uint8_t version;          // 2 (new format)
    uint8_t flags;            // bit0 = per-record t_us present
    uint16_t count;           // number of records in this sweep
    uint16_t failures;        // from readAll
    uint32_t total_time_us;   // total sweep time
    uint32_t packet_time_us;  // FULL micros() when this packet is sent
};

struct Rec18 {
    uint8_t ch;              // channel id
    uint8_t ok;              // 0 or 1
    int32_t raw;             // ADC code
    int32_t sample_time;     // per-sample timestamp (if flags&1)
    uint32_t read_time_dur;  // per read()
    uint32_t conv_time_dur;  // wait for DRDY
};
#pragma pack(pop)

std::atomic<bool> running(true);

void signalHandler(int signum) {
    (void)signum;
    std::cout << "\nStopping fake ESP32 generator..." << std::endl;
    running = false;
}

// Simulate realistic ADC values for pressure transducers
// Assuming ADS1256 with ±2.5V range, 24-bit ADC
// Pressure range: 0-1000 PSI → voltage range: 0.5V - 4.5V
class PTSimulator {
private:
    std::mt19937 gen_;
    std::normal_distribution<double> noise_;

    // Simulated pressure for each channel (in PSI)
    std::vector<double> base_pressures_;
    std::vector<double> pressure_trends_;

public:
    PTSimulator(int num_channels = 10) : gen_(std::random_device{}()), noise_(0.0, 0.001) {
        base_pressures_.resize(num_channels);
        pressure_trends_.resize(num_channels);

        // Initialize with different base pressures
        for (int i = 0; i < num_channels; i++) {
            base_pressures_[i] = 50.0 + i * 100.0;  // 50, 150, 250, ... PSI
            pressure_trends_[i] = 0.0;
        }
    }

    int32_t getRawADC(uint8_t channel) {
        if (channel >= base_pressures_.size()) {
            channel = 0;
        }

        // Add slow drift
        pressure_trends_[channel] += (std::rand() % 100 - 50) * 0.001;
        pressure_trends_[channel] *= 0.99;  // Decay

        // Calculate pressure (PSI)
        double pressure =
            base_pressures_[channel] + pressure_trends_[channel] + noise_(gen_) * 10.0;

        // Convert to voltage: 0 PSI = 0.5V, 1000 PSI = 4.5V
        double voltage = 0.5 + (pressure / 1000.0) * 4.0;
        voltage = std::max(0.0, std::min(5.0, voltage));  // Clamp to 0-5V

        // Convert to 24-bit ADC value (±2.5V reference, gain=1)
        // Full scale = ±2^23, so 2.5V = 2^23
        // Adjust for actual voltage
        int32_t raw = static_cast<int32_t>((voltage - 2.5) / 2.5 * 8388607.0);

        return raw;
    }
};

int main(int argc, char* argv[]) {
    std::cout << "=== FAKE ESP32 PACKET GENERATOR ===" << std::endl;

    if (argc != 2) {
        std::cerr << "Usage: " << argv[0] << " <output_file or pipe>" << std::endl;
        std::cerr << "Example: " << argv[0] << " /tmp/fake_esp32_pipe" << std::endl;
        return 1;
    }

    const char* output_path = argv[1];

    // Set up signal handlers
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Create named pipe if it doesn't exist
    struct stat st;
    if (stat(output_path, &st) != 0) {
        std::cout << "Creating named pipe: " << output_path << std::endl;
        if (mkfifo(output_path, 0666) != 0) {
            std::cerr << "Failed to create named pipe: " << strerror(errno) << std::endl;
            std::cerr << "Trying to use as regular file instead..." << std::endl;
        }
    }

    std::cout << "Opening output: " << output_path << std::endl;

    PTSimulator sim(10);  // 10 PT channels

    // Timing
    auto start_time = std::chrono::high_resolution_clock::now();
    uint64_t packet_count = 0;
    uint32_t simulated_micros = 0;

    std::cout << "\n🚀 Fake ESP32 generator started!" << std::endl;
    std::cout << "Generating realistic PT sensor packets..." << std::endl;
    std::cout << "Press Ctrl+C to stop\n" << std::endl;

    while (running) {
        // Open file/pipe for each packet (in case reader disconnects)
        int fd = open(output_path, O_WRONLY);
        if (fd < 0) {
            std::cerr << "Waiting for reader..." << std::endl;
            sleep(1);
            continue;
        }

        // Simulate reading 10 channels per sweep
        const int NUM_CHANNELS = 10;

        // Create packet header
        ESP32PacketHeader header;
        strncpy(header.magic, "AD26", 4);
        header.version = 2;
        header.flags = 0x01;  // Per-record timestamps present
        header.count = NUM_CHANNELS;
        header.failures = 0;
        header.total_time_us = 50000;  // 50ms per sweep (20Hz)
        header.packet_time_us = simulated_micros;

        // Write header
        if (write(fd, &header, sizeof(header)) != sizeof(header)) {
            std::cerr << "Write error" << std::endl;
            close(fd);
            break;
        }

        // Write records
        for (int ch = 0; ch < NUM_CHANNELS; ch++) {
            Rec18 rec;
            rec.ch = ch;
            rec.ok = 1;  // Success
            rec.raw = sim.getRawADC(ch);
            rec.sample_time = simulated_micros + ch * 5000;   // 5ms per channel
            rec.read_time_dur = 4500 + (std::rand() % 1000);  // ~4.5ms
            rec.conv_time_dur = 4000 + (std::rand() % 500);   // ~4ms

            if (write(fd, &rec, sizeof(rec)) != sizeof(rec)) {
                std::cerr << "Write error on record " << ch << std::endl;
                break;
            }
        }

        close(fd);

        packet_count++;
        simulated_micros += 50000;  // 50ms per sweep

        // Print statistics every 5 seconds
        auto now = std::chrono::high_resolution_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - start_time).count();

        if (packet_count % 100 == 0) {  // Every ~5 seconds at 20Hz
            std::cout << "📊 [" << elapsed << "s] Packets sent: " << packet_count << " ("
                      << (elapsed > 0 ? packet_count / elapsed : 0) << " packets/s, "
                      << (elapsed > 0 ? packet_count * NUM_CHANNELS / elapsed : 0) << " records/s)"
                      << std::endl;

            // Show sample voltage for channel 2
            int32_t raw_ch2 = sim.getRawADC(2);
            double voltage_ch2 = (raw_ch2 / 8388607.0) * 2.5 + 2.5;
            std::cout << "   Sample Ch2: raw=" << raw_ch2 << ", voltage=" << voltage_ch2 << "V"
                      << std::endl;
        }

        // Sleep to simulate 20Hz rate (50ms per sweep)
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    std::cout << "\n🛑 Fake ESP32 generator stopped" << std::endl;
    std::cout << "Total packets sent: " << packet_count << std::endl;

    return 0;
}
