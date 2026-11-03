# t7_bridge: LabJack T7 analog inputs -> Elodin.
#
# LJM (libLabJackM + LabJackM.h) is LabJack's closed-source library, installed separately on the
# DAQ host. Without it t7_bridge still builds and its tests still run, but it only works with
# --fake; a build that cannot find LJM says so here at configure time.

option(WITH_LJM "Build t7_bridge against LabJack LJM when it is installed" ON)

if(WITH_LJM)
    find_path(LJM_INCLUDE_DIR LabJackM.h PATHS /usr/local/include)
    find_library(LJM_LIBRARY LabJackM PATHS /usr/local/lib)
endif()

add_executable(t7_bridge t7_bridge_main.cpp)
target_include_directories(t7_bridge PRIVATE ${COMMON_INCLUDES})
target_link_libraries(t7_bridge fsw_daq_lib daq_comms_lib Threads::Threads pthread ${RT_LIBRARY})

if(WITH_LJM AND LJM_INCLUDE_DIR AND LJM_LIBRARY)
    message(STATUS "t7_bridge: LabJack LJM found (${LJM_LIBRARY})")
    target_sources(t7_bridge PRIVATE LjmT7Device.cpp)
    target_include_directories(t7_bridge PRIVATE ${LJM_INCLUDE_DIR} ${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_definitions(t7_bridge PRIVATE T7_HAVE_LJM)
    target_link_libraries(t7_bridge ${LJM_LIBRARY})
else()
    message(STATUS "t7_bridge: LabJack LJM not found - building --fake only")
endif()

install(TARGETS t7_bridge RUNTIME DESTINATION bin)
