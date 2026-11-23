// Host harness: runs the real daq_link.c + diablo_proto.c with a simulated FDC1004 feed.
// Simulates repeat mode: one channel finishes every 10 ms (100 S/s over 4 channels).
// Channel N reports counts = N*1,000,000 + sample_index, so ordering and IDs can be checked.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "daq_link.h"
#include "freertos/task.h"
int g_test_log_level = 3;
int main(void)
{
    bool sensor_ok = getenv("SENSOR_DOWN") == NULL;
    if (daq_link_start() != ESP_OK) { fprintf(stderr, "start failed\n"); return 1; }
    uint32_t idx[FDC1004_NUM_CH] = {0};
    for (int tick = 0; ; tick++) {
        fdc1004_sample_t s[FDC1004_NUM_CH] = {0};
        if (sensor_ok) {
            int ch = tick % FDC1004_NUM_CH;
            s[ch].fresh = true;
            s[ch].counts = (ch + 1) * 1000000 + (int32_t)idx[ch]++;
            s[ch].pf = s[ch].counts / 524288.0f;
        }
        daq_link_on_samples(s, sensor_ok);
        vTaskDelay(10);
    }
}
