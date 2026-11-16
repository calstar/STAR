# Golden-master characterization suite (docs/remaster/LEDGER.md). Each area lives in its own
# subdirectory with its own CMakeLists.txt and golden/ files; tests carry the "characterization"
# label so `ctest -L characterization` runs exactly this suite. CHAR_UPDATE=1 in the environment
# rewrites the goldens instead of comparing against them — only ever on main's behaviour.
set(CHAR_ROOT ${CMAKE_CURRENT_SOURCE_DIR})
file(GLOB _char_children LIST_DIRECTORIES true ${CMAKE_CURRENT_SOURCE_DIR}/*)
foreach(_child ${_char_children})
    if(IS_DIRECTORY ${_child} AND EXISTS ${_child}/CMakeLists.txt)
        add_subdirectory(${_child})
    endif()
endforeach()
