#ifndef TEST_FREERTOS_H
#define TEST_FREERTOS_H
void fake_enter(void);
void fake_exit(void);
#define taskENTER_CRITICAL() fake_enter()
#define taskEXIT_CRITICAL() fake_exit()
#endif
