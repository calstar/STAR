#ifndef STAR_FUSION_TASK_H
#define STAR_FUSION_TASK_H
#include <stdbool.h>
#include <stdint.h>
bool fusion_task_start(void);
void fusion_task_reset(uint8_t accel_fs_g, uint16_t gyro_fs_dps);
/* Non-blocking copy from either sensor producer; loss is counted. */
void fusion_task_submit(uint8_t type, const void* data, uint8_t len);
#endif
