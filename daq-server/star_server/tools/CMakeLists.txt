# Hermetic developer/operator tools. Nothing here opens a socket, commands a board, or starts a
# service — that is the property that lets them run freely (see daq-server/CLAUDE.md).

# ── state_script_check ────────────────────────────────────────────────────────
# Validates a dynamic-state script against a config. The web backend spawns this on save so the
# config editor can report "line 4: unknown actuator" between sessions, when no sequencer exists.
#
# StateMachine.cpp is linked (not duplicated) so `transition_to` targets are checked against the
# same state_transitions.csv parser the sequencer uses. A second transition-matrix reader would
# eventually disagree with the one that actually refuses the transition.
add_executable(state_script_check
    state_script_check/main.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/StateMachine.cpp
)
target_include_directories(state_script_check PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../lib/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
)
target_link_libraries(state_script_check
    fsw_daq_lib daq_comms_lib daqv2_comms Threads::Threads pthread ${RT_LIBRARY})

install(TARGETS state_script_check RUNTIME DESTINATION bin)
