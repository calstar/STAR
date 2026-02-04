/**
 * @file esp32_pt_streamer.cpp
 * @brief ESP32 PT data streamer using Rec18 packet format
 *
 * Reads the new ESP32 packet format (PacketHeader + Rec18[]) and streams
 * PT messages to Elodin DB for calibration
 */

#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <termios.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <thread>

#include "../../daq_comms/include/comms/PTMessage.hpp"
#include "../comms/include/Timer.hpp"
#include "../external/shared/message_factory/MessageFactory.hpp"
#include "../utl/Elodin.hpp"
#include "../utl/TCPSocket.hpp"
#include "../utl/dbConfig.hpp"

// Global variables for cleanup
std::unique_ptr<Socket> LocalSock;
std::atomic<bool> running(true);
int serial_fd = -1;

// Signal handler for graceful shutdown
void signalHandler(int signum) {
    (void)signum;
    std::cout << "\nShutting down ESP32 PT streamer..." << std::endl;
    running = false;
}

// ESP32 Packet structures matching Arduino code (use ESP32 prefix to avoid conflict)
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

// Open serial port or pipe
bool openSerialPort(const char* device, int baudrate) {
    serial_fd = open(device, O_RDONLY | O_NOCTTY);
    if (serial_fd < 0) {
        std::cerr << "Failed to open " << device << ": " << strerror(errno) << std::endl;
        return false;
    }

    // Check if it's a regular file/pipe or a serial device
    struct stat st;
    if (fstat(serial_fd, &st) == 0) {
        if (S_ISFIFO(st.st_mode) || S_ISREG(st.st_mode)) {
            // It's a pipe or regular file - no serial configuration needed
            std::cout << "✓ Opened pipe/file: " << device << std::endl;
            return true;
        }
    }

    // It's a character device (serial port) - configure it
    struct termios tty;
    memset(&tty, 0, sizeof(tty));

    if (tcgetattr(serial_fd, &tty) != 0) {
        std::cerr << "Error from tcgetattr: " << strerror(errno) << std::endl;
        std::cerr << "Device might not be a serial port, trying to use it anyway..." << std::endl;
        // Don't fail here - might still work as a pipe
        return true;
    }

    // Set baud rate
    speed_t baud = B115200;
    if (baudrate == 921600)
        baud = B921600;
    else if (baudrate == 460800)
        baud = B460800;
    else if (baudrate == 230400)
        baud = B230400;

    cfsetospeed(&tty, baud);
    cfsetispeed(&tty, baud);

    // 8N1 mode
    tty.c_cflag = (tty.c_cflag & ~CSIZE) | CS8;
    tty.c_iflag &= ~IGNBRK;
    tty.c_lflag = 0;
    tty.c_oflag = 0;
    tty.c_cc[VMIN] = 0;
    tty.c_cc[VTIME] = 5;
    tty.c_iflag &= ~(IXON | IXOFF | IXANY);
    tty.c_cflag |= (CLOCAL | CREAD);
    tty.c_cflag &= ~(PARENB | PARODD);
    tty.c_cflag &= ~CSTOPB;
    tty.c_cflag &= ~CRTSCTS;

    if (tcsetattr(serial_fd, TCSANOW, &tty) != 0) {
        std::cerr << "Error from tcsetattr: " << strerror(errno) << std::endl;
        close(serial_fd);
        return false;
    }

    std::cout << "✓ Serial port " << device << " opened at " << baudrate << " baud" << std::endl;
    return true;
}

// Read exact number of bytes from serial port
bool readBytes(void* buffer, size_t count) {
    uint8_t* ptr = (uint8_t*)buffer;
    size_t remaining = count;

    while (remaining > 0 && running) {
        ssize_t n = read(serial_fd, ptr, remaining);
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                usleep(1000);
                continue;
            }
            std::cerr << "Read error: " << strerror(errno) << std::endl;
            return false;
        } else if (n == 0) {
            usleep(1000);
            continue;
        }
        ptr += n;
        remaining -= n;
    }

    return remaining == 0;
}

// Convert raw ADC value to voltage (depends on your ADC config)
// For ADS1256 with 5V ref and gain=1: voltage = (raw / 8388607.0) * 2.5
double rawToVoltage(int32_t raw, double vref = 2.5) {
    return (raw / 8388607.0) * vref;
}

int main(int argc, char* argv[]) {
    std::cout << "=== ESP32 PT STREAMER (Rec18 Format) ===" << std::endl;

    if (argc < 3 || argc > 4) {
        std::cerr << "Usage: " << argv[0] << " <db_host> <db_port> [serial_device]" << std::endl;
        std::cerr << "Example: " << argv[0] << " 127.0.0.1 2240 /dev/ttyACM0" << std::endl;
        std::cerr << "         " << argv[0] << " 127.0.0.1 2240 /tmp/fake_esp32_pipe" << std::endl;
        return 1;
    }

    const char* db_host = argv[1];
    int db_port = std::atoi(argv[2]);
    const char* serial_device = (argc == 4) ? argv[3] : "/dev/ttyACM0";

    // Set up signal handlers
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Connect to Elodin DB
    try {
        std::cout << "Connecting to Elodin DB at " << db_host << ":" << db_port << std::endl;
        LocalSock = std::make_unique<Socket>(db_host, db_port);
        std::cout << "✓ Connected to Elodin DB" << std::endl;
    } catch (const std::exception& e) {
        std::cerr << "Failed to connect to Elodin DB: " << e.what() << std::endl;
        return 1;
    }

    // Send database configuration
    cppGenerateDBConfig();
    std::cout << "✓ Database configuration sent" << std::endl;

    // Open ESP32 serial port or pipe
    int baudrate = 115200;

    std::cout << "Opening ESP32 input: " << serial_device << std::endl;
    if (!openSerialPort(serial_device, baudrate)) {
        return 1;
    }

    std::cout << "\n🚀 ESP32 PT STREAMING STARTED!" << std::endl;
    std::cout << "📡 ESP32 Rec18 packets → PT Messages → Elodin DB" << std::endl;
    std::cout << "Press Ctrl+C to stop...\n" << std::endl;

    // Statistics
    uint64_t total_packets = 0;
    uint64_t total_records = 0;
    std::map<uint8_t, uint64_t> channel_counts;
    auto start_time = std::chrono::steady_clock::now();
    auto last_stats_time = start_time;

    // Main streaming loop
    while (running) {
        // Read packet header
        ESP32PacketHeader header;
        if (!readBytes(&header, sizeof(header))) {
            if (running) {
                std::cerr << "Failed to read packet header" << std::endl;
                usleep(100000);
            }
            continue;
        }

        // Verify magic number
        if (strncmp(header.magic, "AD26", 4) != 0) {
            std::cerr << "Invalid magic number, skipping..." << std::endl;
            continue;
        }

        // Verify version
        if (header.version != 2) {
            std::cerr << "Unsupported version: " << (int)header.version << std::endl;
            continue;
        }

        total_packets++;

        // Read all records
        for (uint16_t i = 0; i < header.count && running; i++) {
            Rec18 rec;
            if (!readBytes(&rec, sizeof(rec))) {
                std::cerr << "Failed to read record " << i << std::endl;
                break;
            }

            // Skip failed reads
            if (rec.ok == 0) {
                continue;
            }

            total_records++;
            channel_counts[rec.ch]++;

            // Create PT message - send raw Rec18 data directly
            PTMessage pt_msg;
            std::get<0>(pt_msg.fields) = rec.ch;             // ch - channel id
            std::get<1>(pt_msg.fields) = rec.ok;             // ok - 0 or 1
            std::get<2>(pt_msg.fields) = 0;                  // padding for alignment
            std::get<3>(pt_msg.fields) = rec.raw;            // raw - ADC code
            std::get<4>(pt_msg.fields) = rec.sample_time;    // sample_time
            std::get<5>(pt_msg.fields) = rec.read_time_dur;  // read_time_dur
            std::get<6>(pt_msg.fields) = rec.conv_time_dur;  // conv_time_dur

            // Debug: print first record to verify all fields
            if (total_records == 1) {
                std::cout << "DEBUG First Record:" << std::endl;
                std::cout << "  ch=" << (int)rec.ch << " ok=" << (int)rec.ok << std::endl;
                std::cout << "  raw=" << rec.raw << " sample_time=" << rec.sample_time << std::endl;
                std::cout << "  read_dur=" << rec.read_time_dur << " conv_dur=" << rec.conv_time_dur
                          << std::endl;
                std::cout << "  Message size: " << MessageSize<PTMessage>::value
                          << " bytes (expected 20 with padding)" << std::endl;
            }

            // Send to Elodin DB
            write_to_elodindb({0x20, 0x00}, pt_msg);
        }

        // Print statistics every 5 seconds
        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration_cast<std::chrono::seconds>(now - last_stats_time).count() >= 5) {
            auto elapsed =
                std::chrono::duration_cast<std::chrono::seconds>(now - start_time).count();

            std::cout << "\n📊 STREAMING STATISTICS (" << elapsed << "s):" << std::endl;
            std::cout << "Total packets: " << total_packets << " ("
                      << (elapsed > 0 ? total_packets / elapsed : 0) << " packets/s)" << std::endl;
            std::cout << "Total records: " << total_records << " ("
                      << (elapsed > 0 ? total_records / elapsed : 0) << " records/s)" << std::endl;

            std::cout << "Channels: ";
            for (const auto& pair : channel_counts) {
                std::cout << (int)pair.first << "=" << pair.second << " ";
            }
            std::cout << std::endl;

            last_stats_time = now;
        }
    }

    // Cleanup
    if (serial_fd >= 0) {
        close(serial_fd);
    }

    std::cout << "\n🛑 ESP32 PT streamer stopped" << std::endl;
    std::cout << "Total packets processed: " << total_packets << std::endl;
    std::cout << "Total records processed: " << total_records << std::endl;

    return 0;
}
