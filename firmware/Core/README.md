# STM32 flight-computer self-test

The portable C self-test coordinator checks a caller-supplied device inventory through an injectable driver interface. Datasheet-backed SPI protocol checks run on a host with fake transport. STM32 adapters and task integration remain incomplete. See [the component map and remaining questions](DEVICE_CHECKS.md).

## Overview

`self_test_port.h` defines three callbacks: `probe`, `read_battery`, and `publish_status`. `self_test.c` manages bounded probe attempts, round-robin scheduling, battery validity, and periodic status publication. It has no HAL, RTOS, register, heap-allocation, arming, or actuator dependencies.

The existing STM32 scaffold initializes peripherals but does not connect the device-level self-test checks to hardware. `StartDefaultTask()` still only calls `osDelay(1)`. The portable coordinator is not invoked on the board yet.

## Architecture

```text
caller supplies config + operations + context + now_ms
                         |
                  self_test.c
                         |
                self_test_port.h
                 /             \
         host fake drivers    future STM32 adapters
```

## Directory structure

```text
Core/
  Inc/self_test_port.h       Driver contracts and status types
  Inc/self_test.h            Coordinator API and caller-owned storage
  Src/self_test.c            Portable coordinator
  Inc/self_test_devices.h    SPI transport contract and logical device IDs
  Src/self_test_devices.c    Datasheet-backed device checks
  DEVICE_CHECKS.md          Component map, evidence and integration questions
  Src/main.c                Existing generated STM32 initialization
../tests/self_test/
  CMakeLists.txt             Standalone host build
  test_self_test.c           Coordinator tests
  test_self_test_devices.c   Protocol and checksum tests
```

## Quick start

Run from the repository root with a C99 compiler and CMake 3.16 or newer:

```sh
cmake -S firmware/tests/self_test -B /tmp/star-self-test -DSELF_TEST_SANITIZERS=ON
cmake --build /tmp/star-self-test
ctest --test-dir /tmp/star-self-test --output-on-failure
```

Sanitizers require Clang or GCC. Omit `-DSELF_TEST_SANITIZERS=ON` on an unsupported toolchain. Tests compile the actual coordinator and device-check sources with warnings treated as errors. Checks remain enabled in Release builds. The firmware workflow includes this host suite separately from the ESP32 builds.

## Caller and driver contracts

Zero-initialize a `self_test_t` and call `self_test_init()` with configuration, an operations table, a driver context, and a monotonic millisecond timestamp. Check its boolean return. Configuration and operations are copied, so their input storage can be temporary; they must not alias the instance being initialized. Context remains driver-owned and may be null for stateless callbacks. Invalid configuration disables the instance. `self_test_status()` returns null for an invalid instance.

Call `self_test_tick()` from one owner. It makes at most one probe, one battery, and one publication callback per tick, regardless of inventory size. Each callback must return within `callback_budget_ms`; configuration requires `tick_budget_ms >= 3 * callback_budget_ms`. That bound covers callback time, with fixed coordinator overhead in addition. This is a cooperative contract, not preemption of a misbehaving driver. Measure worst-case execution time before target integration. No callback may retain a bus lock, active transfer, or borrowed status pointer after returning. Drivers that cannot implement bounded calls need a separate asynchronous driver service that owns and cleans up its transfers; the seam can poll that service's cached state.

The coordinator passes an explicit one-based probe attempt number. Repeated `PENDING` polls keep that number. Each attempt expires at `probe_timeout_ms`, measured from its first call; the callback budget is capped by the remaining attempt time. `FAIL` and `TIMEOUT` retry after `retry_interval_ms`, up to `probe_max_attempts`. `PASS`, `NOT_CONFIGURED`, and `NOT_IMPLEMENTED` are terminal until reset. Other devices keep advancing in round-robin order. Timeout recognition may be delayed until the next visit to that device, at most one full inventory rotation with regular ticks. There are at most eight devices and IDs must be unique.

The inventory scan has a separate `session_timeout_ms` deadline measured from init/reset. Zero selects 29000 ms; explicit values must be 1–29000 ms. Probe callback budgets also respect the remaining session time. At the first tick on or after expiry, all unfinished entries become terminal `TIMEOUT` with `SELF_TEST_DIAG_SESSION_TIMEOUT`, including optional entries and retries. Completed results are preserved. `probes_complete` is true when every inventory entry is terminal (also true for an empty inventory), and `deadline_expired` records forced completion. Both flags reset on a new session. No further probes run once complete, while battery and heartbeat work continues until the caller leaves the state.

Inez confirmed that self-test always hands off to Idle, including when probes fail. Use `probes_complete` to finish the scan, not `probes_outcome == PASS`. The state machine must separately bound report transmission/storage and the Idle transition. The 29-second default reserves one second toward the under-30-second requirement but is not a full boot deadline: schedule ticks often enough and account for callback time, board startup and final reporting. Choose a shorter scan budget when those jobs need more time. Drivers must respect their cooperative budgets.

`self_test_reset()` starts a fresh session without changing configuration or invoking drivers. It clears results, attempt counts, battery validity, and heartbeat timing. Driver callbacks must not require cancellation on reset because they cannot leave owned transactions running between calls. Use reset on re-entry from a future wake/state transition; power-mode control belongs to the caller.

Except for the session deadline described above, all intervals must be between 1 and `INT32_MAX` milliseconds. Use a monotonically increasing `uint32_t` clock, allowing unsigned wraparound, and tick at gaps shorter than `2^31` milliseconds. Reset after a longer suspension or a clock reset.

## Results and heartbeat policy

Each device preserves its ID, requirement flag, result, diagnostic, attempt count, and completion flag. A retryable failure is visible in the device result while `complete` remains false. Missing callbacks report `NOT_IMPLEMENTED`; a present driver can report `NOT_CONFIGURED` when it lacks peer configuration. Unknown result enums become `FAIL` with `SELF_TEST_DIAG_BAD_REPLY`. Negative diagnostic codes are reserved for the coordinator.

`probes_outcome` covers required devices only. It is `PASS` when all required devices pass, `FAIL` when any required device finishes unsuccessfully, and `PENDING` while required checks remain unresolved without a terminal failure. An empty required inventory is `NOT_CONFIGURED`, never pass. Optional device failures remain visible but do not prevent required probes from passing. This field does not establish overall board readiness or authorize a state transition.

Battery validity and publication are independent fields. A required-probe pass can coexist with invalid battery data or a publication failure; callers must inspect those fields if their readiness policy requires them. Battery readings are raw ADC counts only. A successful read must mark the sample valid. Stamp a fresh acquisition with the callback's supplied `now_ms`; a cached sample must retain its original timestamp on that clock. At age `battery_max_age_ms` the sample becomes invalid with a stale diagnostic. Failures, pending reads, unsupported reads, and future-dated samples are invalid. Invalid raw counts are cleared to zero; zero is also a legitimate valid ADC reading, so always check `valid`. There is no voltage conversion or low-battery threshold.

The first heartbeat is attempted on the first tick, after that tick's probe and battery work. Subsequent heartbeats occur on the first tick at or after the configured interval. After a long gap, one current snapshot is published and the schedule restarts from that tick; missed heartbeats are not replayed. A proposed starting interval is 1000 ms, with both 1000 ms and 500 ms covered by tests. No board configuration is selected by this library.

Publication failures, timeouts, and pending delivery retry at `retry_interval_ms`, capped by `publication_max_attempts` per heartbeat interval. Exhausted pending delivery becomes `TIMEOUT`. Unsupported publication does not retry within the interval. Each new heartbeat starts a new attempt budget and supersedes old retries. Snapshots sent to the callback include the previous publication result and the current attempt count; the returned status reflects the new result. `PASS` requires SX1262 TxDone within a timeout. The destination is the ground station, and no acknowledgement is required. This confirms local transmission, not reception. Ryan still owns the packet byte layout. The adapter must bridge the C coordinator to the C++ radio API and cannot return pass for a no-op send.

## Current hardware support and integration decisions

The reviewed baseline is `f8e110d5`, including Inez's `.ioc` corrections in `550e5483`. The [component map](DEVICE_CHECKS.md) records confirmed parts, intended peripheral settings, and remaining questions from [#137](https://github.com/calstar/STAR/issues/137#issuecomment-6486161496).

Five SPI protocol checks exist: IMU, high-g accelerometer, barometer, Ethernet and radio. All three sensor probes request mode 3 for shared SPI3. GNSS UART, SD NAND, eMMC, HAL transport, battery acquisition and telemetry adapters remain unimplemented. Configure three probe attempts for board integration. The required/optional list is still an Arm-policy proposal, so the library does not choose it.

The `.ioc` now contains the corrected SPI, UART and ADC settings, but generated C is stale. The agreed build is CubeMX 6.18.1, FW_H7 V1.13.0, CMake and arm-none-eabi-gcc. The target build dependencies, startup and linker files remain absent. Existing ESP32 CI and host tests cannot verify an STM32 build.

Once the board layer and build exist, pass existing HAL handles in adapter context, add both self-test C sources to that build, and call the coordinator in generated user-code sections. Use static coordinator storage and measure stack high-water usage and execution time before enabling it in the default task. Report persistence, bounded LoRa delivery and the actual Idle transition remain caller responsibilities. Pyro outputs are outside this module.

## Documentation

- [`self_test_port.h`](Inc/self_test_port.h): callback and status contracts.
- [`self_test.h`](Inc/self_test.h): configuration and public coordinator API.
- [`test_self_test.c`](../tests/self_test/test_self_test.c): executable examples with fake devices and time.
- [`firmware.ioc`](../firmware.ioc): existing CubeMX configuration.
- [`firmware README`](../README.md): existing ESP32 workflows.
