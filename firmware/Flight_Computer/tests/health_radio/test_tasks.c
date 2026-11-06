#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>

#include "cmsis_os2.h"
#include "health_task.h"
#include "selftest_radio.h"
#define CHECK(x)                                       \
    do {                                               \
        if (!(x)) {                                    \
            fprintf(stderr, "%d: %s\n", __LINE__, #x); \
            abort();                                   \
        }                                              \
    } while (0)
static uint32_t clock_ms;
static unsigned feeds, starts, depth;
static bool allocate = true, watchdog_ok = true;
static void (*worker)(void*);
static jmp_buf task_return;
uint32_t board_now_ms(void) {
    return clock_ms;
}
bool board_watchdog_start(void) {
    ++starts;
    return watchdog_ok;
}
void board_watchdog_refresh(void) {
    ++feeds;
}
void fake_enter(void) {
    ++depth;
}
void fake_exit(void) {
    CHECK(depth > 0);
    --depth;
}
uint32_t osKernelGetTickFreq(void) {
    return 1000;
}
osThreadId_t osThreadNew(void (*fn)(void*), void* arg,
                         const osThreadAttr_t* attr) {
    CHECK(!arg && attr->stack_size >= 1024);
    worker = fn;
    return allocate ? (void*)1 : NULL;
}
void osDelay(uint32_t ticks) {
    CHECK(depth == 0);
    clock_ms += ticks;
    longjmp(task_return, 1);
}
void osThreadExit(void) {
    CHECK(depth == 0);
    longjmp(task_return, 1);
}
static void once(void) {
    CHECK(worker);
    if (!setjmp(task_return))
        worker(NULL);
}
static void beat(void) {
    for (unsigned i = 0; i < HEALTH_COUNT; ++i)
        health_task_beat((health_id_t)i);
}
static void health_test(void) {
    health_task_init();
    CHECK(!health_task_prepare_sleep(10000));
    CHECK(health_task_start() && starts == 1);
    once();
    CHECK(feeds == 1);
    clock_ms = 1000;
    beat();
    CHECK(health_task_prepare_sleep(10000));
    CHECK(feeds == 2);
    /* HAL stopped for 10 seconds. resume must advance monitor time once. */
    CHECK(health_task_resume(10000));
    CHECK(feeds == 3);
    /* Without the RTC offset, health_resume sees zero elapsed time. The
     * next beat would incorrectly keep the pre-sleep age; force that case. */
    clock_ms = 1500;
    beat();
    once();
    CHECK(feeds == 4);
    CHECK(!health_task_resume(10000));
    CHECK(feeds == 4);
    clock_ms = 6500;
    once();
    CHECK(feeds == 4);
    CHECK(health_task_faults() == HEALTH_ALL);
    beat();
    once();
    CHECK(feeds == 4);  // faults stay latched
    CHECK(!health_task_prepare_sleep(10000));
    health_task_init();
    CHECK(health_task_start());
    CHECK(health_task_prepare_sleep(10000));
    unsigned before = feeds;
    CHECK(!health_task_resume(11001));
    CHECK(feeds == before);
    health_task_init();
    CHECK(health_task_start());
    CHECK(health_task_prepare_sleep(10000));
    clock_ms += 200;  // HAL ran during entry/exit
    CHECK(health_task_resume(1000));
    beat();
    once();
    CHECK(health_task_faults() == 0);
    health_task_init();
    CHECK(health_task_start());
    CHECK(health_task_prepare_sleep(10000));
    clock_ms += 200;
    before = feeds;
    CHECK(!health_task_resume(100));
    CHECK(feeds == before);
    CHECK(health_task_faults() == HEALTH_ALL);
    health_task_init();
    CHECK(health_task_start());
    CHECK(health_task_prepare_sleep(1000));
    before = feeds;
    CHECK(!health_task_resume(2001)); /* shorter requested sleep deadline */
    CHECK(feeds == before && health_task_faults() == HEALTH_ALL);
    health_task_init();
    allocate = false;
    before = starts;
    CHECK(!health_task_start() &&
          starts == before + 1);  // hardware still armed
    allocate = true;
    watchdog_ok = false;
    CHECK(!health_task_start());
    CHECK(health_task_faults() == HEALTH_ALL);
}
static void radio_test(void) {
    CHECK(selftest_radio_task_start(0x55, 8000));
    for (unsigned i = 0; i < 40 && !g_selftest_radio.finished; ++i)
        once();
    CHECK(g_selftest_radio.finished && g_selftest_radio.attempts == 3);
    CHECK(g_selftest_radio.result ==
          SELFTEST_TX_UNAVAILABLE);  // real weak hook
    allocate = false;
    CHECK(!selftest_radio_task_start(0, 0));
    CHECK(g_selftest_radio.finished &&
          g_selftest_radio.result == SELFTEST_TX_ERROR);
}
int main(void) {
    health_test();
    radio_test();
    puts("RTOS adapter tests passed");
}
