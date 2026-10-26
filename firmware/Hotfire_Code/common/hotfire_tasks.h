/**
 * Shared FreeRTOS task helpers for the hotfire boards: the task watchdog and
 * stack headroom reports. Used by the sensor core and the actuator board.
 */

#pragma once

#include <Arduino.h>
#include <esp_idf_version.h>
#include <esp_task_wdt.h>

#include "hotfire_log.h"

// Priority does not rank the hotfire tasks against each other: each board
// pins its two tasks to different cores. 5 keeps them above Arduino's
// loopTask (1) and the idle tasks (0), and well below ESP-IDF's system
// tasks (esp_timer 22, ipc 24).
constexpr UBaseType_t HOTFIRE_TASK_PRIORITY = 5;

/** Task watchdog period: a task that stops checking in reboots the board. */
constexpr uint32_t TASK_WATCHDOG_TIMEOUT_S = 5;

/**
 * Subscribe the calling task to the task watchdog. If a subscribed task
 * stops calling watchdogCheckIn() for TASK_WATCHDOG_TIMEOUT_S, the board
 * reboots and comes back in WaitingForServer.
 */
inline void watchdogSubscribe(const char* task_name) {
    esp_err_t err = esp_task_wdt_add(nullptr);
    if (err == ESP_ERR_INVALID_STATE) {
        // This core's sdkconfig did not start the watchdog; start it.
#if ESP_IDF_VERSION_MAJOR >= 5
        esp_task_wdt_config_t wdt = {};
        wdt.timeout_ms = TASK_WATCHDOG_TIMEOUT_S * 1000;
        wdt.trigger_panic = true;
        esp_task_wdt_init(&wdt);
#else
        esp_task_wdt_init(TASK_WATCHDOG_TIMEOUT_S, true);
#endif
        err = esp_task_wdt_add(nullptr);
    }
    if (err != ESP_OK) {
        HF_LOG("[TASK] WARNING: ");
        HF_LOG(task_name);
        HF_LOGLN(" could not join the task watchdog");
    }
}

inline void watchdogCheckIn() {
    esp_task_wdt_reset();
}

/** Print how much of the calling task's stack has never been touched. */
inline void logStackHeadroom(const char* task_name) {
    HF_LOG("[TASK] ");
    HF_LOG(task_name);
    HF_LOG(" stack headroom: ");
    HF_LOG(static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
    HF_LOGLN(" bytes");
}

/** Periodic headroom report: once 5 s after start, then every 30 s when
 *  verbose. */
inline void maybeLogStackHeadroom(const char* task_name,
                                  unsigned long& next_ms, bool& first_done) {
    const unsigned long now = millis();
    if (static_cast<long>(now - next_ms) < 0)
        return;
    if (!first_done || g_verbose)
        logStackHeadroom(task_name);
    first_done = true;
    next_ms = now + 30000;
}
