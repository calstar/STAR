cmake_minimum_required(VERSION 3.10)
project(ism330dhcx_firmware C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -Wall -Wextra -Wpedantic -O2")

include_directories(include)

# Static library for ISM330DHCX driver
add_library(ism330dhcx STATIC
    src/ism330dhcx.c
)

# Example executable
add_executable(avionics_imu_demo
    examples/main_avionics_firmware.c
)

target_link_libraries(avionics_imu_demo PRIVATE ism330dhcx m)
