#pragma once
#include "FreeRTOS.h"
typedef void (*TaskFunction_t)(void *);
static inline void vTaskDelay(TickType_t ms) { usleep((useconds_t)ms * 1000); }
struct test_task_arg { TaskFunction_t fn; void *arg; };
static void *test_task_tramp(void *a) { struct test_task_arg *t = a; t->fn(t->arg); return NULL; }
static inline int xTaskCreate(TaskFunction_t fn, const char *n, uint32_t st, void *arg, int prio, void *h)
{ (void)n; (void)st; (void)prio; (void)h; static struct test_task_arg a[8]; static int k; a[k] = (struct test_task_arg){fn, arg};
  pthread_t th; pthread_create(&th, NULL, test_task_tramp, &a[k++]); pthread_detach(th); return 1; }
