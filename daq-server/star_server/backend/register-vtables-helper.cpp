// Quick helper to register VTables with Elodin DB
// Uses existing FSW DatabaseConfig code

#include <iostream>
#include <string>

#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"

int main(int argc, char* argv[]) {
    if (argc < 3) {
        std::cerr << "Usage: " << argv[0] << " <host> <port>" << std::endl;
        return 1;
    }

    std::string host = argv[1];
    int port = std::stoi(argv[2]);

    std::cout << "Connecting to Elodin DB at " << host << ":" << port << "..." << std::endl;

    fsw::elodin::ElodinClient client;
    if (!client.connect(host, port)) {
        std::cerr << "❌ Failed to connect to Elodin DB" << std::endl;
        return 1;
    }

    std::cout << "✅ Connected to Elodin DB" << std::endl;
    std::cout << "Registering VTables..." << std::endl;

    if (!fsw::elodin::DatabaseConfig::register_tables(client)) {
        std::cerr << "❌ VTable registration failed" << std::endl;
        return 1;
    }

    std::cout << "✅ VTables registered successfully" << std::endl;
    std::cout << "Elodin DB should now stream data to all connected clients" << std::endl;

    // Keep connection alive briefly
    std::this_thread::sleep_for(std::chrono::milliseconds(100));

    return 0;
}
