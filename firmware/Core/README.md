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

`self_test_reset()` starts a fresh session without changing configuration or invoking drivers. It clears results, attempt counts, battery validity, and heartbeat timing. Driver callbacks must not require cancellation on reset because they cannot leave owned transactions running between calls. Use reset on re-entry from a future wake/state transition; power-mode control belongs to the caller.

All intervals must be between 1 and `INT32_MAX` milliseconds. Use a monotonically increasing `uint32_t` clock, allowing unsigned wraparound, and tick at gaps shorter than `2^31` milliseconds. Reset after a longer suspension or a clock reset.

## Results and heartbeat policy

Each device preserves its ID, requirement flag, result, diagnostic, attempt count, and completion flag. A retryable failure is visible in the device result while `complete` remains false. Missing callbacks report `NOT_IMPLEMENTED`; a present driver can report `NOT_CONFIGURED` when it lacks peer configuration. Unknown result enums become `FAIL` with `SELF_TEST_DIAG_BAD_REPLY`. Negative diagnostic codes are reserved for the coordinator.

`probes_outcome` covers required devices only. It is `PASS` when all required devices pass, `FAIL` when any required device finishes unsuccessfully, and `PENDING` while required checks remain unresolved without a terminal failure. An empty required inventory is `NOT_CONFIGURED`, never pass. Optional device failures remain visible but do not prevent required probes from passing. This field does not establish overall board readiness or authorize a state transition.

Battery validity and publication are independent fields. A required-probe pass can coexist with invalid battery data or a publication failure; callers must inspect those fields if their readiness policy requires them. Battery readings are raw ADC counts only. A successful read must mark the sample valid. Stamp a fresh acquisition with the callback's supplied `now_ms`; a cached sample must retain its original timestamp on that clock. At age `battery_max_age_ms` the sample becomes invalid with a stale diagnostic. Failures, pending reads, unsupported reads, and future-dated samples are invalid. Invalid raw counts are cleared to zero; zero is also a legitimate valid ADC reading, so always check `valid`. There is no voltage conversion or low-battery threshold.

The first heartbeat is attempted on the first tick, after that tick's probe and battery work. Subsequent heartbeats occur on the first tick at or after the configured interval. After a long gap, one current snapshot is published and the schedule restarts from that tick; missed heartbeats are not replayed. A proposed starting interval is 1000 ms, with both 1000 ms and 500 ms covered by tests. No board configuration is selected by this library.

Publication failures, timeouts, and pending delivery retry at `retry_interval_ms`, capped by `publication_max_attempts` per heartbeat interval. Exhausted pending delivery becomes `TIMEOUT`. Unsupported publication does not retry within the interval. Each new heartbeat starts a new attempt budget and supersedes old retries. Snapshots sent to the callback include the previous publication result and the current attempt count; the returned status reflects the new result. `PASS` requires the adapter's documented delivery criterion. Enqueueing bytes alone must not imply a verified link. Telemetry encoding, destination, and acknowledgements belong outside the coordinator.

## Current hardware support and integration decisions

The inspected flight-computer baseline is `d8c5c06ae5bfecc1a927a044371915037cf9a025`. The following scaffold exists:

| Area | Present | Still needed |
| --- | --- | --- |
| Target | `.ioc` selects STM32H723VET6 and CMSIS-RTOS v2 | Confirm this is the tracker task's intended base |
| SPI | SPI1 radio, SPI2 Ethernet, SPI3 sensors, SPI4 NAND routing | Five protocol checks supplied; confirm populated parts and implement bounded SPI adapter/startup |
| UART/I2C | UART9 at 115200 and initialized I2C4 | Confirm peers, addresses and health-check protocols |
| Battery | PA0/ADC1 channel 16, 16-bit configuration | HAL acquisition, sampling suitability, calibration, divider and reference before volts/thresholds |
| Heartbeat | Portable publication callback and schedule | Destination, packet format, transport and delivery criterion |
| Task | Generated default task with 512-byte stack | Verified target build, adapters, stack and timing measurements before invocation |

IMU, high-g accelerometer, barometer, Ethernet and radio protocol checks are supplied in `self_test_devices.c`. No HAL transport, ADC acquisition, or telemetry adapter is supplied yet. The repository lacks the STM32 HAL driver sources/headers, CMSIS device/core and RTOS dependencies, system/startup source, linker configuration, and target project/build files. `stm32h7xx_hal_conf.h` and `FreeRTOSConfig.h` are configuration headers, not those dependencies. `.ioc` records STM32Cube FW_H7 V1.13.0 and `EWARM V8.50`; confirm the team's generation version and toolchain before creating build files. Existing PlatformIO targets and firmware CI build ESP32 projects, not this STM32 scaffold.

Before integration, confirm the tracker acceptance criteria and required device inventory. Then provide verified adapters through `self_test_port_t`, passing existing HAL handles by pointer in context. Add `self_test.c` and `self_test_devices.c` to the confirmed target build. Keep substantial adapter logic in separate files and initialization/tick calls inside generated user-code sections. Use static storage for the coordinator and measure task stack high-water usage, including driver and encoding calls; do not place the entire instance or large snapshots on the 512-byte task stack. Do not enable calls in `StartDefaultTask()` until that build and timing review succeeds.

The generated scaffold also needs hardware review independently of this seam. All four SPI initializers use 4-bit data frames. Several chip selects and peripheral reset pins start low. GPIO names involving pyro enable/power-good have differing input/output roles, and the RTOS stack-overflow hook is empty. Their suitability cannot be established from pin names. This implementation leaves those settings and all arming/pyro controls unchanged.

## Documentation

- [`self_test_port.h`](Inc/self_test_port.h): callback and status contracts.
- [`self_test.h`](Inc/self_test.h): configuration and public coordinator API.
- [`test_self_test.c`](../tests/self_test/test_self_test.c): executable examples with fake devices and time.
- [`firmware.ioc`](../firmware.ioc): existing CubeMX configuration.
- [`firmware README`](../README.md): existing ESP32 workflows.
