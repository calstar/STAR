#include "board_dfu.h"

#include "FreeRTOS.h"
#include "cmsis_os2.h"
#include "main.h"
#include "task.h"
#include "usbd_core.h"

extern USBD_HandleTypeDef hUsbDeviceHS;

/* AN2606, table "Bootloader device-dependent parameters": STM32H72xxx/73xxx
 * system memory (bootloader) base. Word 0 is its initial MSP, word 1 its
 * reset vector. */
#define SYSTEM_MEMORY 0x1FF09800UL

void board_dfu_enter(void) {
    /* Detach first, with interrupts and the tick alive (HAL_PCD_Stop and
     * the disconnect use HAL_Delay), and give the host time to see the
     * serial port go, so it enumerates the bootloader as a new device. */
    (void)USBD_Stop(&hUsbDeviceHS);
    (void)USBD_DeInit(&hUsbDeviceHS);
    /* 1 s off the bus: with 200 ms, macOS sometimes left the bootloader's
     * device half set up ("!registered" in ioreg, invisible to dfu-util) on
     * the rev 1 board B. */
    osDelay(1000U);

    vTaskSuspendAll();
    __disable_irq();
    SysTick->CTRL = 0U;
    for (uint32_t i = 0; i < sizeof NVIC->ICER / sizeof NVIC->ICER[0]; ++i) {
        NVIC->ICER[i] = 0xFFFFFFFFUL;
        NVIC->ICPR[i] = 0xFFFFFFFFUL;
    }
    /* The bootloader expects reset state: caches off, clocks on HSI, the
     * peripherals (SPI, timers, USB, DMA) reset. Not GPIO (AHB4) or APB4:
     * the pins keep driving what they drive now (pyro enables low, rails
     * on). AHB3 only for SDMMC1: writing all of AHB3RSTR reset the chip
     * outright on the rev 1 board (SWD: "external reset" at that write). */
    if (SCB->CCR & SCB_CCR_DC_Msk) {
        SCB_DisableDCache();
    }
    if (SCB->CCR & SCB_CCR_IC_Msk) {
        SCB_DisableICache();
    }
    (void)HAL_RCC_DeInit();
    volatile uint32_t* const resets[] = {
        &RCC->AHB1RSTR,  &RCC->AHB2RSTR, &RCC->APB1LRSTR,
        &RCC->APB1HRSTR, &RCC->APB2RSTR, &RCC->APB3RSTR,
    };
    for (uint32_t i = 0; i < sizeof resets / sizeof resets[0]; ++i) {
        *resets[i] = 0xFFFFFFFFUL;
        *resets[i] = 0U;
    }
    RCC->AHB3RSTR = RCC_AHB3RSTR_SDMMC1RST;
    RCC->AHB3RSTR = 0U;
    /* GPIO/SYSCFG are not reset, so the app's EXTI lines (IMU, high-g,
     * radio interrupts) stay armed: one firing in the bootloader landed in
     * its default handler (rev 1 board, SWD: IPSR 56 = EXTI15_10) and it
     * hung after the flash. Mask and clear every line. */
    EXTI->RTSR1 = EXTI->FTSR1 = 0U;
    EXTI->RTSR2 = EXTI->FTSR2 = 0U;
    EXTI->RTSR3 = EXTI->FTSR3 = 0U;
    EXTI_D1->IMR1 = EXTI_D1->EMR1 = 0U;
    EXTI_D1->IMR2 = EXTI_D1->EMR2 = 0U;
    EXTI_D1->IMR3 = EXTI_D1->EMR3 = 0U;
    EXTI_D1->PR1 = EXTI_D1->PR2 = EXTI_D1->PR3 = 0xFFFFFFFFUL;

    /* Tasks run on PSP; the bootloader starts as from reset, on MSP. */
    __set_CONTROL(0U);
    __ISB();
    const uint32_t* vectors = (const uint32_t*)SYSTEM_MEMORY;
    __set_MSP(vectors[0]);
    __DSB();
    __ISB();
    __enable_irq(); /* PRIMASK as at reset; NVIC lines are all off */
    ((void (*)(void))vectors[1])();
    for (;;) {
    }
}
