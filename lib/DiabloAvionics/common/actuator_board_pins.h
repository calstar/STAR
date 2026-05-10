#pragma once

#include <stdint.h>

//define actuator board pins to be imported where needed
namespace actuator_board_pins {
    struct Layout {
        // Ethernet pins (same for all DAQv2 boards)
        int ETH_MOSI;
        int ETH_MISO;
        int ETH_SCLK;
        int ETH_CS;
        int ETH_INT;
        int ETH_RST;

        // Actuator GPIO pins (1-indexed: ACTUATOR_1 through ACTUATOR_10)
        int ACTUATOR_1;
        int ACTUATOR_2;
        int ACTUATOR_3;
        int ACTUATOR_4;
        int ACTUATOR_5;
        int ACTUATOR_6;
        int ACTUATOR_7;
        int ACTUATOR_8;
        int ACTUATOR_9;
        int ACTUATOR_10;

        // Current sense pins (for future use, ignored for now)
        int CURRENT_SENSE_1;
        int CURRENT_SENSE_2;
        int CURRENT_SENSE_3;
        int CURRENT_SENSE_4;
        int CURRENT_SENSE_5;
        int CURRENT_SENSE_6;
        int CURRENT_SENSE_7;
        int CURRENT_SENSE_8;
        int CURRENT_SENSE_9;
        int CURRENT_SENSE_10;

        // Status LED
        int LED;
    };

    const Layout Actuator_Board = {
        // ETH_MOSI, ETH_MISO, ETH_SCLK, ETH_CS, ETH_INT, ETH_RST
        40, 41, 39, 38, 37, 21,
        
        // ACTUATOR_1 through ACTUATOR_10
        //7, 5, 48, 21, 36, 6, 4, 47, 14, 35,
        4, 6, 14, 21, 35, 5, 7, 21, 48, 36,

        // CURRENT_SENSE_1 through CURRENT_SENSE_10
        // Hardware mapping: 1→18, 2→9, 3→13, 4→11, 5→1, 6→17, 7→8, 8→10, 9→12, 10→2
        18, 9, 13, 11, 1, 17, 8, 10, 12, 2,

        // LED
        15
    };

    // Maximum number of actuators supported by hardware (physical pin limit)
    // Actual number of actuators in use should be determined dynamically from config/CSV at runtime
    constexpr int MAX_ACTUATORS = 10;
    // For backward compatibility, keep NUM_ACTUATORS as MAX_ACTUATORS
    // But prefer using runtime config/CSV to determine actual count
    constexpr int NUM_ACTUATORS = MAX_ACTUATORS;

    // Get actuator pin number by 1-indexed actuator ID
    // Returns the GPIO pin number for the given actuator (1-10)
    inline int getActuatorPin(uint8_t actuator_id) {
        switch(actuator_id) {
            case 1: return Actuator_Board.ACTUATOR_1;
            case 2: return Actuator_Board.ACTUATOR_2;
            case 3: return Actuator_Board.ACTUATOR_3;
            case 4: return Actuator_Board.ACTUATOR_4;
            case 5: return Actuator_Board.ACTUATOR_5;
            case 6: return Actuator_Board.ACTUATOR_6;
            case 7: return Actuator_Board.ACTUATOR_7;
            case 8: return Actuator_Board.ACTUATOR_8;
            case 9: return Actuator_Board.ACTUATOR_9;
            case 10: return Actuator_Board.ACTUATOR_10;
            default: return -1; // Invalid actuator ID
        }
    }

    // Get current sense pin number by 1-indexed actuator ID (1-10)
    // Returns the GPIO pin number for the given current sense pin
    inline int getCurrentSensePin(uint8_t actuator_id) {
        switch(actuator_id) {
            case 1: return Actuator_Board.CURRENT_SENSE_1;
            case 2: return Actuator_Board.CURRENT_SENSE_2;
            case 3: return Actuator_Board.CURRENT_SENSE_3;
            case 4: return Actuator_Board.CURRENT_SENSE_4;
            case 5: return Actuator_Board.CURRENT_SENSE_5;
            case 6: return Actuator_Board.CURRENT_SENSE_6;
            case 7: return Actuator_Board.CURRENT_SENSE_7;
            case 8: return Actuator_Board.CURRENT_SENSE_8;
            case 9: return Actuator_Board.CURRENT_SENSE_9;
            case 10: return Actuator_Board.CURRENT_SENSE_10;
            default: return -1; // Invalid actuator ID
        }
    }
}
