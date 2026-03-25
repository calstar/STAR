#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <fstream>
#include <iostream>
#include <thread>
#include <vector>

#include "control/SequencerService.hpp"

using namespace sequencer;

// Dummy TCP server thread to act as Elodin DB
void dummy_tcp_server(int& out_port, std::vector<uint8_t>& out_data, bool& run) {
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR | SO_REUSEPORT, &opt, sizeof(opt));

    struct sockaddr_in address;
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = INADDR_ANY;
    address.sin_port = 0;  // OS assigns random port

    bind(server_fd, (struct sockaddr*)&address, sizeof(address));
    socklen_t addrlen = sizeof(address);
    getsockname(server_fd, (struct sockaddr*)&address, &addrlen);
    out_port = ntohs(address.sin_port);

    listen(server_fd, 1);

    // Non-blocking accept so we can exit if sequenced fails
    struct timeval tv;
    tv.tv_sec = 2;  // 2 sec timeout
    tv.tv_usec = 0;
    setsockopt(server_fd, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof tv);

    int new_socket = accept(server_fd, nullptr, nullptr);
    if (new_socket >= 0) {
        // Connected! Read until closed
        setsockopt(new_socket, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof tv);
        uint8_t buffer[1024];
        while (run) {
            int valread = read(new_socket, buffer, 1024);
            if (valread <= 0)
                break;
            for (int i = 0; i < valread; ++i)
                out_data.push_back(buffer[i]);
        }
        close(new_socket);
    }

    close(server_fd);
}

int main() {
    std::cout << "=== SequencerService Elodin DB Integration Test ===" << std::endl;

    int elodin_port = 0;
    std::vector<uint8_t> received_data;
    bool run_server = true;

    std::thread server_thread(dummy_tcp_server, std::ref(elodin_port), std::ref(received_data),
                              std::ref(run_server));

    // Wait for OS to assign port
    while (elodin_port == 0)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));

    std::string test_config = "test_elodin_cfg.toml";
    {
        std::ofstream f(test_config);
        f << "[database]\nhost=\"127.0.0.1\"\nport=" << elodin_port << "\n";
    }

    SequencerService seq;
    if (!seq.init(test_config)) {
        std::cerr << "❌ FAILED: Sequencer init failed (ensure you are running from repository "
                     "root where config/ and external/ exist)\n";
        run_server = false;
        server_thread.join();
        return 1;
    }

    // Give connection time to establish and schemas to register
    std::this_thread::sleep_for(std::chrono::milliseconds(100));

    // Trigger State Transition
    std::cout << "Transitioning to ARMED...\n";
    seq.transitionTo("Armed");

    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    run_server = false;  // signals server to exit
    server_thread.join();

    remove(test_config.c_str());

    if (received_data.empty()) {
        std::cerr << "❌ FAILED: Elodin mock server received 0 bytes\n";
        return 1;
    }

    // The VTable schema setup for SequencerState and StateTransition is roughly ~500 bytes and the
    // 2 actual publishes are another ~35 bytes.
    if (received_data.size() < 100) {
        std::cerr << "❌ FAILED: Received unexpectedly small amount of bytes ("
                  << received_data.size() << ") for schemas and data\n";
        return 1;
    }

    std::cout << "✅ SUCCESS: Elodin mock server gracefully received " << received_data.size()
              << " bytes of serialized schemas and state transitions.\n";
    return 0;
}
