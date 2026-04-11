#include <iostream>

#include "data_logger/DataLoggerService.hpp"

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <config_path>" << std::endl;
        return 1;
    }

    fsw::data_logger::DataLoggerService service;
    if (!service.initialize(argv[1])) {
        return 1;
    }

    std::cout << "[DataLogger] Service started. Waiting for ARMED state..." << std::endl;
    service.run();

    return 0;
}
