cmake_minimum_required(VERSION 3.16)
project(ed_physics C)

# ---------------------------------------------------------------------------
# STAR EngineDesign native physics kernel (parallel implementation).
# Builds libed_physics (static + shared), unit/golden tests, and the benchmark.
# No dependency on the Python package; tables/golden vectors are produced offline
# by engine/native/tools/*.py and read from tests/golden/.
# ---------------------------------------------------------------------------

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

option(ED_NATIVE_ARCH "Enable -march=native (non-portable)" ON)
option(ED_ENABLE_LTO  "Enable link-time optimization in Release" ON)
option(ED_FAST_MATH   "Enable -ffast-math (documented parity tradeoff)" OFF)

# Hot-path optimization + warning flags, compiler-aware so the same tree builds
# on macOS/Linux (GCC/Clang) and Windows (MSVC). NOTE: -ffast-math / /fp:fast
# break strict IEEE (no NaN propagation, reassociation). The CEA NaN-corner
# fallback and residual NaN guards depend on NaN semantics, so fast-math is OFF
# by default; enable only for isolated nozzle/stability arithmetic and document
# any parity delta in README.md.
if(MSVC)
  set(ED_OPT_FLAGS /O2)
  set(ED_WARN_FLAGS /W3)
  if(ED_FAST_MATH)
    list(APPEND ED_OPT_FLAGS /fp:fast)
  endif()
  # -march=native has no MSVC analogue we rely on; ED_NATIVE_ARCH is a no-op here.
else()
  set(ED_OPT_FLAGS -O3)
  set(ED_WARN_FLAGS -Wall -Wextra)
  if(ED_NATIVE_ARCH)
    include(CheckCCompilerFlag)
    check_c_compiler_flag("-march=native" ED_HAS_MARCH_NATIVE)
    if(ED_HAS_MARCH_NATIVE)
      list(APPEND ED_OPT_FLAGS -march=native)
    endif()
  endif()
  if(ED_FAST_MATH)
    list(APPEND ED_OPT_FLAGS -ffast-math)
  endif()
endif()

set(ED_SOURCES
  src/ed_abi.c
  src/ed_workspace.c
  src/ed_cea.c
  src/ed_root_find.c
  src/ed_feed_loss.c
  src/ed_discharge.c
  src/ed_spray.c
  src/ed_combustion_eff.c
  src/ed_combustion_physics.c
  src/ed_injector_pintle.c
  src/ed_injector_impinging.c
  src/ed_injector_coaxial.c
  src/ed_chamber.c
  src/ed_cooling.c
  src/ed_nozzle.c
  src/ed_evaluate.c
  src/ed_stability.c
  src/ed_stability_modes.c
)

add_library(ed_physics_obj OBJECT ${ED_SOURCES})
target_include_directories(ed_physics_obj PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(ed_physics_obj PRIVATE ${ED_WARN_FLAGS}
  $<$<CONFIG:Release>:${ED_OPT_FLAGS}>)

add_library(ed_physics        STATIC $<TARGET_OBJECTS:ed_physics_obj>)
add_library(ed_physics_shared SHARED $<TARGET_OBJECTS:ed_physics_obj>)
set_target_properties(ed_physics_shared PROPERTIES OUTPUT_NAME ed_physics)
# Export all symbols from the DLL on Windows (MSVC hides them by default), so the
# ctypes shim resolves ed_* without per-function __declspec annotations.
set_target_properties(ed_physics_shared PROPERTIES WINDOWS_EXPORT_ALL_SYMBOLS ON)
foreach(t ed_physics ed_physics_shared)
  target_include_directories(${t} PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
  # libm is a separate library only on UNIX; on Windows math lives in the CRT.
  if(NOT WIN32)
    target_link_libraries(${t} PUBLIC m)
  endif()
endforeach()

if(ED_ENABLE_LTO)
  include(CheckIPOSupported)
  check_ipo_supported(RESULT ED_IPO_OK OUTPUT _ipo_msg)
  if(ED_IPO_OK)
    set_property(TARGET ed_physics_obj ed_physics ed_physics_shared
                 PROPERTY INTERPROCEDURAL_OPTIMIZATION_RELEASE ON)
  endif()
endif()

# Golden data location (produced by tools/export_*.py). Passed to tests.
set(ED_GOLDEN_DIR "${CMAKE_CURRENT_SOURCE_DIR}/tests/golden")

# ---- Tests ----------------------------------------------------------------
enable_testing()

add_executable(test_root_find tests/test_root_find.c)
target_link_libraries(test_root_find PRIVATE ed_physics)
add_test(NAME root_find COMMAND test_root_find)

add_executable(test_cea_interp tests/test_cea_interp.c)
target_link_libraries(test_cea_interp PRIVATE ed_physics)
target_compile_definitions(test_cea_interp PRIVATE ED_GOLDEN_DIR="${ED_GOLDEN_DIR}")
add_test(NAME cea_interp COMMAND test_cea_interp)

add_executable(test_feed_discharge tests/test_feed_discharge.c)
target_link_libraries(test_feed_discharge PRIVATE ed_physics)
target_compile_definitions(test_feed_discharge PRIVATE ED_GOLDEN_DIR="${ED_GOLDEN_DIR}")
add_test(NAME feed_discharge COMMAND test_feed_discharge)

add_executable(test_residual_golden tests/test_residual_golden.c)
target_link_libraries(test_residual_golden PRIVATE ed_physics)
target_compile_definitions(test_residual_golden PRIVATE ED_GOLDEN_DIR="${ED_GOLDEN_DIR}")
add_test(NAME residual_golden COMMAND test_residual_golden)

add_executable(test_injector_golden tests/test_injector_golden.c)
target_link_libraries(test_injector_golden PRIVATE ed_physics)
target_compile_definitions(test_injector_golden PRIVATE ED_GOLDEN_DIR="${ED_GOLDEN_DIR}")
add_test(NAME injector_golden COMMAND test_injector_golden)

add_executable(test_nozzle_golden tests/test_nozzle_golden.c)
target_link_libraries(test_nozzle_golden PRIVATE ed_physics)
target_compile_definitions(test_nozzle_golden PRIVATE ED_GOLDEN_DIR="${ED_GOLDEN_DIR}")
add_test(NAME nozzle_golden COMMAND test_nozzle_golden)

# Golden chamber/evaluate/stability tests are wired but skip (exit 77) until the
# corresponding physics stages land; they assert ED_ERR_NOT_IMPLEMENTED today.
add_executable(test_chamber_golden tests/test_chamber_golden.c)
target_link_libraries(test_chamber_golden PRIVATE ed_physics)
target_compile_definitions(test_chamber_golden PRIVATE ED_GOLDEN_DIR="${ED_GOLDEN_DIR}")
add_test(NAME chamber_golden COMMAND test_chamber_golden)
set_tests_properties(chamber_golden PROPERTIES SKIP_RETURN_CODE 77)

# ---- Benchmark ------------------------------------------------------------
add_executable(bench_evaluate bench/bench_evaluate.c)
target_link_libraries(bench_evaluate PRIVATE ed_physics)
target_compile_options(bench_evaluate PRIVATE $<$<CONFIG:Release>:${ED_OPT_FLAGS}>)
target_compile_definitions(bench_evaluate PRIVATE ED_GOLDEN_DIR="${ED_GOLDEN_DIR}")
