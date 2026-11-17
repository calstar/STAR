#include "fusion_task.h"

#include <string.h>

#include "FreeRTOS.h"
#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "fusion.h"
#include "nand_stm32.h"
#include "task.h"

/* Set only after a three-axis mounting check on the assembled board.
 * A zero default leaves the unverified high-g frame out of the estimate. */
#ifndef STAR_HIGHG_AXIS_X
#define STAR_HIGHG_AXIS_X 0
#endif
#ifndef STAR_HIGHG_AXIS_Y
#define STAR_HIGHG_AXIS_Y 0
#endif
#ifndef STAR_HIGHG_AXIS_Z
#define STAR_HIGHG_AXIS_Z 0
#endif

/* 32 records cover about 24 ms at the default aggregate sensor rate.
 * The Realtime sensor task only copies; this AboveNormal task does math.
 * No producer waits for fusion or for either storage device. */
typedef struct {
    uint32_t generation;
    uint16_t gyro_fs;
    uint8_t accel_fs, type, len;
    uint8_t data[sizeof(rec_gnss_t)];
} message_t;
static osMessageQueueId_t queue;
static uint32_t generation, queue_drops, imu_drops;
static uint8_t accel_fs;
static uint16_t gyro_fs;
static fusion_t filter;

void fusion_task_reset(uint8_t accel, uint16_t gyro) {
    taskENTER_CRITICAL();
    ++generation;
    if (!generation)
        ++generation;
    accel_fs = accel;
    gyro_fs = gyro;
    queue_drops = 0;
    imu_drops = 0;
    taskEXIT_CRITICAL();
}

void fusion_task_submit(uint8_t type, const void* data, uint8_t len) {
    if (!queue || !data || len > sizeof(((message_t*)0)->data))
        return;
    message_t message = {0};
    taskENTER_CRITICAL();
    message.generation = generation;
    message.accel_fs = accel_fs;
    message.gyro_fs = gyro_fs;
    taskEXIT_CRITICAL();
    if (!message.generation)
        return;
    message.type = type;
    message.len = len;
    memcpy(message.data, data, len);
    if (osMessageQueuePut(queue, &message, 0, 0) != osOK) {
        taskENTER_CRITICAL();
        ++queue_drops;
        if (type == REC_IMU)
            ++imu_drops;
        taskEXIT_CRITICAL();
    }
}

static void run(void* argument) {
    (void)argument;
    message_t message;
    uint32_t current = 0;
    for (;;) {
        if (osMessageQueueGet(queue, &message, NULL, osWaitForever) != osOK)
            continue;
        taskENTER_CRITICAL();
        uint32_t latest = generation, lost = queue_drops, lost_imu = imu_drops;
        taskEXIT_CRITICAL();
        if (message.generation != latest)
            continue;
        if (current != message.generation) {
            current = message.generation;
            fusion_init(&filter, message.accel_fs, message.gyro_fs);
            const int8_t axes[3] = {STAR_HIGHG_AXIS_X, STAR_HIGHG_AXIS_Y,
                                    STAR_HIGHG_AXIS_Z};
            (void)fusion_set_highg_axes(&filter, axes);
        }
        if (lost)
            filter.flags |= FUSION_GAP;
        if (lost_imu && (filter.flags & FUSION_READY))
            filter.flags |= FUSION_ATTITUDE_LOST;
        rec_fusion_t output;
        if (!fusion_feed(&filter, message.type, message.data, message.len,
                         &output))
            continue;
        output.dropped += lost;
        uint32_t tick = osKernelGetTickCount();
        (void)emmc_log_append(emmc_stm32_log(), REC_FUSION, tick, &output,
                              sizeof output);
        (void)emmc_log_append(nand_stm32_log(), REC_FUSION, tick, &output,
                              sizeof output);
    }
}

bool fusion_task_start(void) {
    static const osThreadAttr_t attr = {.name = "fusion",
                                        .stack_size = 2048,
                                        .priority = osPriorityAboveNormal};
    queue = osMessageQueueNew(32, sizeof(message_t), NULL);
    if (!queue)
        return false;
    if (!osThreadNew(run, NULL, &attr)) {
        osMessageQueueDelete(queue);
        queue = NULL;
        return false;
    }
    return true;
}
